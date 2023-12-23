const amqp = require('amqplib')
const parseDuration = require('parse-duration')
// const logger = require('../config/logger')

const constants = { 
    DLX_TASKS_EXCHANGE: 'DLX_TASKS_EXCHANGE',
    TTL_TASKS_EXCHANGE: 'TTL_TASKS'
}

class InvalidDelayValueError extends Error{
    constructor(message) {
        super(message);
        this.name = 'InvalidDelayValueError';
    }
}

const getRetryQueueName = delayMin => `tasks-retry-${delayMin}`;

const getRetryQueueSettings = delayStr => {
    let delayTimeMs;
    try {
        delayTimeMs = parseDuration(delayStr, 'ms');
        const delayTimeMin = Math.round(delayTimeMs / (60*1000))
        const delayQueueName = getRetryQueueName(delayTimeMin)
        if(delayTimeMin < 1) {
            throw new InvalidDelayValueError(`Delay value must be greater than, or equal to 1m`)
        }
        return {
            name: delayQueueName,
            messageTtl: delayTimeMs,
            durable: true,
            deadLetterExchange: constants.DLX_TASKS_EXCHANGE,
            routingKeyBinding: `*.${delayTimeMin}m`,
            exchange: constants.TTL_TASKS_EXCHANGE
        }
    } catch (err) {
        throw new InvalidDelayValueError(`Unable to parse ${delayStr} into ms`)
    }
}

const createClient = setting => amqp.connect({
    protocol: setting.AMQP_PROTOCOL,
    username: setting.AMQP_USERNAME,
    password: setting.AMQP_PASSWORD,
    hostname: setting.AMQP_HOSTNAME,
    port: setting.AMQP_PORT,
    vhost: setting.AMQP_VHOST,
    heartbeat: setting.AMQP_HEARTBEAT
}).then(conn => conn);

const sendMessageToQueue = (channel, message, queue) => new Promise(() => {
    logger.info(`Sending message in queue: ${queue}`);
    channel.sendToQueue(queue, Buffer.from(message));
})

const getRetryRoutingKey = ({serviceName, delay}) => {
    let delayTimeMs;
    try {
        delayTimeMs = parseDuration(delay, 'ms');
        const delayTimeMin = Math.round(delayTimeMs / (60*1000));
        return {
            routingKeyBinding: `${serviceName}.${delayTimeMin}m`
        }
    } catch (err) {
        throw new InvalidDelayValueError(`Unable to parse ${delay} into ms`)
    }
}

module.exports = {
    sendMessageToQueue,
    createClient,
    constants,
    getRetryQueueName,
    getRetryQueueSettings, 
    errors: {
        InvalidDelayValueError
    },
    getRetryRoutingKey
}