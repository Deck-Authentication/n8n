/* eslint-disable import/no-cycle */
/* eslint-disable @typescript-eslint/no-non-null-assertion */
/* eslint-disable @typescript-eslint/restrict-template-expressions */
/* eslint-disable no-param-reassign */
import {
	INode,
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	IRunExecutionData,
	NodeHelpers,
	WebhookHttpMethod,
	Workflow,
	LoggerProxy as Logger,
} from 'n8n-workflow';

import express from 'express';

import {
	Db,
	IExecutionResponse,
	IResponseCallbackData,
	IWorkflowDb,
	NodeTypes,
	ResponseHelper,
	WebhookHelpers,
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	WorkflowCredentials,
	WorkflowExecuteAdditionalData,
} from '.';
import { getWorkflowOwner } from './UserManagement/UserManagementHelper';

export class WaitingWebhooks {
	async executeWebhook(
		httpMethod: WebhookHttpMethod,
		fullPath: string,
		req: express.Request,
		res: express.Response,
	): Promise<IResponseCallbackData> {
		Logger.debug(`Received waiting-webhoook "${httpMethod}" for path "${fullPath}"`);

		// Reset request parameters
		req.params = {};

		// Remove trailing slash
		if (fullPath.endsWith('/')) {
			fullPath = fullPath.slice(0, -1);
		}

		const pathParts = fullPath.split('/');

		const executionId = pathParts.shift();
		const path = pathParts.join('/');

		const execution = await Db.collections.Execution?.findOne(executionId);

		if (execution === undefined) {
			throw new ResponseHelper.ResponseError(
				`The execution "${executionId} does not exist.`,
				404,
				404,
			);
		}

		const fullExecutionData = ResponseHelper.unflattenExecutionData(execution);

		if (fullExecutionData.finished || fullExecutionData.data.resultData.error) {
			throw new ResponseHelper.ResponseError(
				`The execution "${executionId} has finished already.`,
				409,
				409,
			);
		}

		return this.startExecution(httpMethod, path, fullExecutionData, req, res);
	}

	async startExecution(
		httpMethod: WebhookHttpMethod,
		path: string,
		fullExecutionData: IExecutionResponse,
		req: express.Request,
		res: express.Response,
	): Promise<IResponseCallbackData> {
		const executionId = fullExecutionData.id;

		if (fullExecutionData.finished) {
			throw new Error('The execution did succeed and can so not be started again.');
		}

		const lastNodeExecuted = fullExecutionData.data.resultData.lastNodeExecuted as string;

		// Set the node as disabled so that the data does not get executed again as it would result
		// in starting the wait all over again
		fullExecutionData.data.executionData!.nodeExecutionStack[0].node.disabled = true;

		// Remove waitTill information else the execution would stop
		fullExecutionData.data.waitTill = undefined;

		// Remove the data of the node execution again else it will display the node as executed twice
		fullExecutionData.data.resultData.runData[lastNodeExecuted].pop();

		const { workflowData } = fullExecutionData;

		const nodeTypes = NodeTypes();
		const workflow = new Workflow({
			id: workflowData.id!.toString(),
			name: workflowData.name,
			nodes: workflowData.nodes,
			connections: workflowData.connections,
			active: workflowData.active,
			nodeTypes,
			staticData: workflowData.staticData,
			settings: workflowData.settings,
		});

		let workflowOwner;
		try {
			workflowOwner = await getWorkflowOwner(workflowData.id!.toString());
		} catch (error) {
			throw new ResponseHelper.ResponseError('Could not find workflow', undefined, 404);
		}

		const additionalData = await WorkflowExecuteAdditionalData.getBase(workflowOwner.id);

		const webhookData = NodeHelpers.getNodeWebhooks(
			workflow,
			workflow.getNode(lastNodeExecuted) as INode,
			additionalData,
		).filter((webhook) => {
			return (
				webhook.httpMethod === httpMethod &&
				webhook.path === path &&
				webhook.webhookDescription.restartWebhook === true
			);
		})[0];

		if (webhookData === undefined) {
			// If no data got found it means that the execution can not be started via a webhook.
			// Return 404 because we do not want to give any data if the execution exists or not.
			const errorMessage = `The execution "${executionId}" with webhook suffix path "${path}" is not known.`;
			throw new ResponseHelper.ResponseError(errorMessage, 404, 404);
		}

		const workflowStartNode = workflow.getNode(lastNodeExecuted);

		if (workflowStartNode === null) {
			throw new ResponseHelper.ResponseError('Could not find node to process webhook.', 404, 404);
		}

		const runExecutionData = fullExecutionData.data;

		return new Promise((resolve, reject) => {
			const executionMode = 'webhook';
			// eslint-disable-next-line @typescript-eslint/no-floating-promises
			WebhookHelpers.executeWebhook(
				workflow,
				webhookData,
				workflowData as IWorkflowDb,
				workflowStartNode,
				executionMode,
				undefined,
				runExecutionData,
				fullExecutionData.id,
				req,
				res,
				// eslint-disable-next-line consistent-return
				(error: Error | null, data: object) => {
					if (error !== null) {
						return reject(error);
					}
					resolve(data);
				},
			);
		});
	}
}
