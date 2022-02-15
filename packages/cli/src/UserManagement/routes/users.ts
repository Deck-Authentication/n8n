/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable import/no-cycle */
/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { Request, Response } from 'express';
import { getConnection, In } from 'typeorm';
import { LoggerProxy } from 'n8n-workflow';
import { genSaltSync, hashSync } from 'bcryptjs';
import validator from 'validator';

import { Db, GenericHelpers, ResponseHelper } from '../..';
import { N8nApp } from '../Interfaces';
import { AuthenticatedRequest, UserRequest } from '../../requests';
import { isEmailSetup, sanitizeUser } from '../UserManagementHelper';
import { User } from '../../databases/entities/User';
import { SharedWorkflow } from '../../databases/entities/SharedWorkflow';
import { SharedCredentials } from '../../databases/entities/SharedCredentials';
import { getInstance } from '../email/UserManagementMailer';
import { issueCookie } from '../auth/jwt';
import { getLogger } from '../../Logger';

LoggerProxy.init(getLogger());

export function usersNamespace(this: N8nApp): void {
	this.app.post(
		`/${this.restEndpoint}/users`,
		ResponseHelper.send(async (req: UserRequest.Invite) => {
			if (!isEmailSetup()) {
				LoggerProxy.error('Attempted to send invite email without emailing being set up');
				throw new ResponseHelper.ResponseError(
					'Email sending must be set up in order to invite other users',
					undefined,
					500,
				);
			}

			const invitations = req.body;

			if (!Array.isArray(invitations)) {
				throw new ResponseHelper.ResponseError('Invalid payload', undefined, 400);
			}

			const createUsers: { [key: string]: string | null } = {};
			// Validate payload
			invitations.forEach((invitation) => {
				if (!validator.isEmail(invitation.email)) {
					LoggerProxy.error('Invalid email in payload at POST /users');
					throw new ResponseHelper.ResponseError(
						`Invalid email address ${invitation.email}`,
						undefined,
						400,
					);
				}
				createUsers[invitation.email] = null;
			});

			const role = await Db.collections.Role!.findOne({ scope: 'global', name: 'member' });

			if (!role) {
				LoggerProxy.error('Failed to find global member role in DB at POST /users');
				throw new ResponseHelper.ResponseError(
					'Members role not found in database - inconsistent state',
					undefined,
					500,
				);
			}

			// remove/exclude existing users from creation
			const existingUsers = await Db.collections.User!.find({
				where: { email: In(Object.keys(createUsers)) },
			});
			existingUsers.forEach((user) => {
				if (user.password) {
					delete createUsers[user.email];
					return;
				}
				createUsers[user.email] = user.id;
			});

			LoggerProxy.debug('Creating user shells at POST /users', { createUsers });

			try {
				await getConnection().transaction(async (transactionManager) => {
					return Promise.all(
						Object.keys(createUsers)
							.filter((email) => createUsers[email] === null)
							.map(async (email) => {
								const newUser = Object.assign(new User(), {
									email,
									globalRole: role,
								});
								const savedUser = await transactionManager.save<User>(newUser);
								createUsers[savedUser.email] = savedUser.id;
								return savedUser;
							}),
					);
				});
			} catch (error) {
				LoggerProxy.error('Failed to create user shells at POST /users', { createUsers });
				throw new ResponseHelper.ResponseError(`An error occurred during user creation`);
			}

			LoggerProxy.debug('Created user shells successfully at POST /users', { createUsers });

			let domain = GenericHelpers.getBaseUrl();
			if (domain.endsWith('/')) {
				domain = domain.slice(0, domain.length - 1);
			}

			// send invite email to new or not yet setup users
			const mailer = getInstance();
			await Promise.all(
				Object.entries(createUsers)
					.filter(([email, id]) => id && email)
					.map(async ([email, id]) => {
						// eslint-disable-next-line @typescript-eslint/restrict-template-expressions
						const inviteAcceptUrl = `${domain}/signup/inviterId=${req.user.id}&inviteeId=${id}`;
						const result = await mailer.invite({
							email,
							inviteAcceptUrl,
							domain,
						});
						const resp: { id: string | null; email: string; error?: string } = {
							id,
							email,
						};
						if (!result.success) {
							LoggerProxy.debug('Failed to send email', { inviteAcceptUrl, domain, email, result });
							resp.error = `Email could not be sent`;
						}
						return resp;
					}),
			);

			const emails =
				Object.entries(createUsers).filter(([email, id]) => id && email).length > 1
					? 'emails'
					: 'email';

			LoggerProxy.debug(`Sent invite ${emails} successfully at POST /users`, { createUsers });
		}),
	);

	this.app.get(
		`/${this.restEndpoint}/resolve-signup-token`,
		ResponseHelper.send(async (req: Request) => {
			const inviterId = req.query.inviterId as string;
			const inviteeId = req.query.inviteeId as string;

			if (!inviterId || !inviteeId) {
				LoggerProxy.error('Missing user IDs at GET /resolve-signup-token', {
					inviterId,
					inviteeId,
				});
				throw new ResponseHelper.ResponseError('Invalid payload', undefined, 400);
			}

			const users = await Db.collections.User!.find({ where: { id: In([inviterId, inviteeId]) } });

			if (users.length !== 2) {
				LoggerProxy.error('Invalid user IDs at GET /resolve-signup-token', {
					inviterId,
					inviteeId,
				});
				throw new ResponseHelper.ResponseError('Invalid invite URL', undefined, 500);
			}

			const inviter = users.find((user) => user.id === inviterId);

			if (!inviter || !inviter.email || !inviter.firstName) {
				LoggerProxy.error(
					'Missing inviter or inviter email or inviter firstName at GET /resolve-signup-token',
					{
						inviter,
					},
				);
				throw new ResponseHelper.ResponseError('Invalid request', undefined, 500);
			}
			const { firstName, lastName } = inviter;

			return { inviter: { firstName, lastName } };
		}),
	);

	this.app.post(
		`/${this.restEndpoint}/user`,
		ResponseHelper.send(async (req: AuthenticatedRequest, res: Response) => {
			if (req.user) {
				throw new ResponseHelper.ResponseError(
					'Please logout before accepting another invite.',
					undefined,
					500,
				);
			}

			const { inviterId, inviteeId, firstName, lastName, password } = req.body as {
				inviterId: string;
				inviteeId: string;
				firstName: string;
				lastName: string;
				password: string;
			};

			if (!inviterId || !inviteeId || !firstName || !lastName || !password) {
				LoggerProxy.error('Invalid payload at POST /users/:id', { payload: req.body });
				throw new ResponseHelper.ResponseError('Invalid payload', undefined, 500);
			}

			const users = await Db.collections.User!.find({
				where: { id: In([inviterId, inviteeId]) },
			});

			if (users.length !== 2) {
				LoggerProxy.error('Invalid user IDs at POST /users/:id', {
					inviterId,
					inviteeId,
				});
				throw new ResponseHelper.ResponseError('Invalid invite URL', undefined, 500);
			}

			const invitee = users.find((user) => user.id === inviteeId);

			if (!invitee || invitee.password) {
				LoggerProxy.error('Attempted to accept already accepted invite at POST /users/:id', {
					inviteeId,
				});
				throw new ResponseHelper.ResponseError(
					'This invite has been accepted already',
					undefined,
					400,
				);
			}

			invitee.firstName = firstName;
			invitee.lastName = lastName;
			invitee.password = hashSync(password, genSaltSync(10));

			const updatedUser = await Db.collections.User!.save(invitee);

			await issueCookie(res, updatedUser);

			return sanitizeUser(updatedUser);
		}),
	);

	this.app.get(
		`/${this.restEndpoint}/users`,
		ResponseHelper.send(async () => {
			const users = await Db.collections.User!.find({ relations: ['globalRole'] });

			return users.map((user) => sanitizeUser(user));
		}),
	);

	this.app.delete(
		`/${this.restEndpoint}/users/:id`,
		ResponseHelper.send(async (req: UserRequest.Delete) => {
			if (req.user.id === req.params.id) {
				LoggerProxy.error('Attempted to delete self', { userId: req.user.id });
				throw new ResponseHelper.ResponseError('You cannot delete your own user', undefined, 400);
			}

			const { transferId } = req.query;

			const searchIds = [req.params.id];
			if (transferId) {
				if (transferId === req.params.id) {
					throw new ResponseHelper.ResponseError(
						'Removed user and transferred user cannot be the same',
						undefined,
						400,
					);
				}
				searchIds.push(transferId);
			}

			const users = await Db.collections.User!.find({ where: { id: In(searchIds) } });
			if ((transferId && users.length !== 2) || users.length === 0) {
				throw new ResponseHelper.ResponseError('Could not find user', undefined, 404);
			}

			const deleteUser = users.find((user) => user.id === req.params.id) as User;

			if (transferId) {
				const transferUser = users.find((user) => user.id === transferId) as User;
				await getConnection().transaction(async (transactionManager) => {
					await transactionManager.update(
						SharedWorkflow,
						{ user: deleteUser },
						{ user: transferUser },
					);
					await transactionManager.update(
						SharedCredentials,
						{ user: deleteUser },
						{ user: transferUser },
					);
					await transactionManager.delete(User, { id: deleteUser.id });
				});
			} else {
				const [ownedWorkflows, ownedCredentials] = await Promise.all([
					Db.collections.SharedWorkflow!.find({
						relations: ['workflow'],
						where: { user: deleteUser },
					}),
					Db.collections.SharedCredentials!.find({
						relations: ['credentials'],
						where: { user: deleteUser },
					}),
				]);
				await getConnection().transaction(async (transactionManager) => {
					await transactionManager.remove(ownedWorkflows.map(({ workflow }) => workflow));
					await transactionManager.remove(ownedCredentials.map(({ credentials }) => credentials));
					await transactionManager.delete(User, { id: deleteUser.id });
				});
			}
			return { success: true };
		}),
	);

	this.app.post(
		`/${this.restEndpoint}/users/:id/reinvite`,
		ResponseHelper.send(async (req: UserRequest.Reinvite) => {
			if (!isEmailSetup()) {
				LoggerProxy.error(
					'Attempted to send reinvite user without email sending being set up at /users/:id/reinvite',
				);
				throw new ResponseHelper.ResponseError(
					'Email sending must be set up in order to invite other users',
					undefined,
					500,
				);
			}

			const user = await Db.collections.User!.findOne({ id: req.params.id });

			if (!user) {
				LoggerProxy.error(
					'Attempted to send reinvite user without email sending being set up at /users/:id/reinvite',
				);
				throw new ResponseHelper.ResponseError('User not found', undefined, 404);
			}

			if (user.password) {
				LoggerProxy.error(
					'Attempted to accept already accepted invite at POST /users/:id/reinvite',
					{
						userId: user.id,
					},
				);
				throw new ResponseHelper.ResponseError(
					'User has already accepted the invite',
					undefined,
					400,
				);
			}

			let domain = GenericHelpers.getBaseUrl();
			if (domain.endsWith('/')) {
				domain = domain.slice(0, domain.length - 1);
			}

			const inviteAcceptUrl = `${domain}/signup/inviterId=${req.user.id}&inviteeId=${user.id}`;

			const mailer = getInstance();
			const result = await mailer.invite({
				email: user.email,
				inviteAcceptUrl,
				domain,
			});

			if (!result.success) {
				LoggerProxy.debug('Failed to send email', {
					inviteAcceptUrl,
					email: user.email,
					domain,
					result,
				});
				throw new ResponseHelper.ResponseError(
					`Failed to send email to ${user.email}`,
					undefined,
					500,
				);
			}
			return { success: true };
		}),
	);
}