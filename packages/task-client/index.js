const httpContext = require('express-http-context')
const { v4: uuidv4 } = require('uuid')
const logger = require('../config/logger')

const amqpClient = require('../utils/amqp.util');
const envConfig = require('../../../../Facebook/src/config/config');

const createTaskSignature = ({ data }) => JSON.stringify(data);
const getTaskId = async ({ metadata, taskName }) => {
    let taskId = null;
    return taskId || uuidv4()
}

const syncTask = async (serviceName, handlerName, params, options = {}) => {
    const metadata ={ ...params?.metadata, ...httpContext.get("metadata") }
    const { traceId } = metadata || {};
    const jwtBearerToken = metadata.jwtHeaderToken;

    const serviceConfig = SERVICE_MAP[serviceName]
    let status = TASK_STATUS_ENUM.INITIALIZED;
    let data = null;
    let error;

    const taskId = params?.taskId || (await getTaskId({ metadata, taskName, handlerName }));

    logger.info(`TASK_SERVER | ${handlerName} | sync | ${taskId} | INITIALIZED`);

    let signature;
    if (options?.idempotent) {
        signature = createTaskSignature(params);
    }

    const url = `https://${serviceConfig.host}:${serviceConfig.port}/${handlerName}`
    const headers = {
        "task-id": taskId,
        "x-trace-id": traceId,
        "x-api-name": `TASK-${handlerName}`,
        timeout: envConfig.TASK_TIME_OUT - serviceConfig.depth * 3000
    }

    if (jwtBearerToken) {
        headers["x-jwt-key"] = jwtBearerToken
    }

    const axios = axiosInstance({
        timeOut: envConfig.TASK_TIME_OUT - serviceConfig.depth * 3000,
        disableLogging: true
    })

    try {
        let taskResponse;
        if (handlerName === HEALTH_CHECK_PATH) {
            taskResponse = await axios.get(url, {headers})
        } else {
            taskResponse = await axios.post(
                url,
                {
                    ...params?.data,
                    metadata,
                    context: params?.context
                },
                { headers }
            )
        }
        data = taskResponse.data;
        logger.info(`TASK_CLIENT | ${handlerName} | sync | ${taskId} | COMPLETED`);
    } catch (error) {
        status = TASK_STATUS_ENUM.error
        error = error.isAxiosError ? err?.response?.data : err;
        if (error.code === "ECONNREFUSED") {
            logger.error(`TASK_CLIENT | ${handlerName} | sync | ${taskId} | ${serviceName} is not available at ${url}`)
        } else {
            logger.error(`TASK_CLIENT | ${handlerName} | sync | ${taskId} | ERROR, ${error}`)
        }
    }

    if (error) {
        throw error;
    } else {
        return {
            taskId,
            status,
            error,
            data
        }
    }
}

const asyncTask = async (serviceName, handlerName, params, options = {}) => {
    const { delay, idempotent } = options;
    const metadata = { ...params.metadata, ...httpContext.get("metadata") };
    const channel = httpContext.channel;

    let signature
    if (idempotent) {
        signature = createTaskSignature(params)
    }

    let traceId
    if (!metadata.traceId) {
        traceId = ""
        metadata.traceId = traceId;
    } else {
        traceId = metadata.traceId
    }

    const taskId = await getTaskId({ metadata, taskName: handlerName })

    const queueName = `${serviceName}-queue`;
    const {data} = params

    const message = {
        taskId,
        serviceName,
        handlerName,
        data,
        metadata
    }

    if (delay) {
        logger.info(`TASK_CLIENT | ${handlerName} | async | ${taskId} | DELAYED | Delay: ${delay}`)
        const delayQueueSettings = amqpClient.getRetryQueueSettings(delay)

        try {
            await channel.assertQueue(delayQueueSettings.name, {
                durable: delayQueueSettings.durable,
                deadLetterExchange: delayQueueSettings.deadLetterExchange,
                messageTtl: delayQueueSettings.messageTtl
            })

            await channel.bindQueue(
                delayQueueSettings.name,
                delayQueueSettings.exchange,
                delayQueueSettings.routingKeyBinding
            )

            const { routingKeyBinding } = amqpClient.getRetryRoutingKey({
                serviceName,
                delay
            })
            await  channel.publish(
                delayQueueSettings.exchange,
                routingKeyBinding,
                Buffer.from(JSON.stringify(message)),
                {persistent: true}
            )
        } catch (err) {
            logger.info(`TASK_CLIENT | ${handlerName} | async | ${taskId} | Unable to delay task: ${err?.message}`)
            throw `Unable to delay task: ${err}`
        }
    } else {
        logger.info(`TASK_CLIENT | ${handlerName} | async | ${taskId} | QUEUED`)
        channel.assertQueue(queueName, {durable: true})
        amqpClient.sendMessageToQueue(channel, JSON.stringify(message), queueName)
    }

    return {
        taskId
    }
}

const microTask = async (callback, { taskName, remark, params, ids = null }) => {
    const metadata = { ...params.metadata, ...httpContext.get("metadata") };
    taskName = taskName || callback?.name;
    logger.info(`MICRO_TASK | ${taskName} | IN_PROGRESS`);

    let status = TASK_STATUS_ENUM.IN_PROGRESS;
    let data = null;
    let error;

    try {
        if (ids) {
            data = await callback(ids, params);
        } else {
            data = await callback(params);
        }
        status = TASK_STATUS_ENUM.COMPLETED;
        logger.info(`MICRO_TASK | ${taskName} | COMPLETED`);
        try {
            logger.info(`MICRO_TASK | ${taskName} | RESULT`, {data: stringify(data)});
        } catch (error) {
            logger.debug(`MICRO_TASK | ${taskName} | RESULT`, {data})
        }
    } catch (error) {
        logger.error(`MICRO_TASK | ${taskName} | ERROR`, {err});
        error = err;
        status: TASK_STATUS_ENUM.ERROR
    }

    if (error) {
        throw error;
    } else {
        return {
            status,
            error,
            data: data?.data || data,
        };
    }
}

module.exports = {
    asyncTask,
    syncTask,
    microTask
}