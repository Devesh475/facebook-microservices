const mongoose = require('mongoose');
const express = require('express')
require('express-async-errors')
const express = require('express');
const helmet = require('helmet');
const xss = require('xss-clean');
const mongoSanitize = require('express-mongo-sanitize');
const compression = require('compression');
const cors = require('cors');
const httpStatus = require('http-status');
// const envConfig = require('./config');
const morgan = require('morgan');
// const {authLimiter} = require('./middlewares/rateLimiter');
// const routes = require('./routes/v1');
// const { errorConverter, errorHandler } = require('./middlewares/error');
// const ApiError = require('./utils/ApiError');
const cookies = require('cookie-parser');

// const app = require('./app');
// const envConfig = require('./config/index');
// const logger = require('./config/logger')
// const amqpClient = require('./utils/amqp.util')
const httpContext = require('express-http-context');
const { v4: uuidv4 } = require('uuid')
// const { rabbitMq } = require('./controller/blog.controller')

mongoose.set('debug', envConfig.MONGOOSE_DEBUG);

const setupRabbitMQResources = async function ({
    serviceName,
    channel,
    queueName
}) {


    const exchanges = [
        // { name: 'TASKS', type: 'direct' },
        { name: amqpClient.constants.TTL_TASKS_EXCHANGE, type: 'topic' },
        { name: amqpClient.constants.DLX_TASKS_EXCHANGE, type: 'topic' }
    ]

    const defaultRetryQueue = amqpClient.getRetryQueueSettings('10m')

    const queue = [{ name: queueName }, defaultRetryQueue]


    const exchangePromises = exchanges.map(({name, type}) => {
        channel.assertExchange(name, type, {durable: true})
    })


    await Promise.all(exchangePromises)

    const queuePromises = queue.map(({name, deadLetterExchange, messageTtl}) => {
        channel.assertQueue(name, {durable: true, deadLetterExchange, messageTtl})
    })

    await Promise.all(queuePromises)

    const queueExchangeBindingPromises = []
    queueExchangeBindingPromises.concat(
        // channel.bindQueue(queueName, 'TASKS', serviceName)
        channel.bindQueue(
            queueName, amqpClient.constants.DLX_TASKS_EXCHANGE,
            `${serviceName}.*`
        ),
        channel.bindQueue(
            defaultRetryQueue.name,
            defaultRetryQueue.exchange,
            defaultRetryQueue.routingKeyBinding
        )
    )
    await Promise.all(queueExchangeBindingPromises)
}

const processTask = async ({
    serviceName,
    handlerName,
    handler,
    taskType,
    taskId,
    data,
    metadata,
    context,
    channel,
    req,
    async = false
}) => {
    httpContext.set('metadata', metadata)
    httpContext.channel = channel
    const requesttype = async ? 'async' : 'sync'

    const taskIdToUse = taskId || uuidv4()

    logger.info(`PROCESS TASK | ${handlerName} | ${requesttype} | ${taskIdToUse} | IN_PROGRESS`)

    if (envConfig.NODE_ENV !== 'development') {
        logger.info(`PROCESS TASK | ${handlerName} | ${requesttype} | ${taskIdToUse} | IN_PROGRESS`, data)
    }

    let result = null;
    try {
        result = await handler({
            logger,
            data,
            metadata,
            req,
            context,
            channel
        })
        logger.info(`PROCESS TASK | ${handlerName} | ${requesttype} | ${taskIdToUse} | COMPLETED`)
    } catch(e) {
        if (e.code === 52) {
            logger.info(`PROCESS TASK | ${handlerName} | ${requesttype} | ${taskIdToUse} | DOLLAR_PREFIX_IN_NAME`)

        } else {
            logger.info(`PROCESS TASK | ${handlerName} | ${requesttype} | ${taskIdToUse} | ERROR, ${e.message}`, {err: e})
            try{

            }catch(errSave){
                logger.info(`PROCESS TASK | ${handlerName} | ${requesttype} | ${taskIdToUse} | ERROR_SAVE`)
            }
            throw e;
        }
    } finally {

    }
    return result
}

const startListener = async ({serviceName, channel, handlers}) => {
    logger.info('Starting task listener')
    const queueName = `${serviceName}-queue`

    await setupRabbitMQResources({
        serviceName,
        channel,
        handlers,
        queueName
    })
    channel.prefetch(envConfig.DEFAULT_AMQP_CONSUMER_PREFETCH_COUNT)
    channel.consume(queueName, async (msg) => {
        const param = JSON.parse(msg.content.toString());
        const { handlerName, metadata, data, taskId } = param;

        try {
            if (msg.fields.redelivered) {
                throw Error('Message redelivered')
            }

            // TODO: rum this for all the handlers which are to be run via rabbitMq
            const handler = handlers.handlerName
            httpContext.ns.run(async () => {
                try {
                    await processTask({
                        serviceName,
                        handlerName,
                        handler,
                        taskType: 'TASK',
                        taskId,
                        data,
                        metadata,
                        logger,
                        channel,
                        async: true
                    })
                } catch (err) {

                } finally {
                    channel.ack(msg)
                }
            })
        } catch (e) {
            logger.info(`Task | ${handlerName} | async | ${taskId} | ERROR ${e}`, {err: e})
            channel.ack(msg)
        }
    })
}

const createConnection = async (serviceName, handlers, disableAsync) => {
    const amqpConnection = await amqpClient.createClient(envConfig)
    const amqpChannel = await amqpConnection.createChannel()
    amqpConnection.on('close', () => {
        logger.info(`RabbitMq connection closed | Reconnecting | serviceName: ${serviceName}`)
        createConnection(serviceName, handlers, disableAsync)
    })

    amqpConnection.on('error', (error) => {
        logger.info(`RabbitMq connction error | Reconnecting | serviceName: ${serviceName}`, error)
    })
    if (!disableAsync) {
        startListener({ serviceName, channel: amqpChannel, handlers })
    }
    return { amqpChannel, amqpConnection }
}

const startTaskServer = async (serviceName, config, handlers) => {
    try {
        const serverPort = config.port || envConfig.port;
        const middlewares = config.middlewares || []
        const disableAsync = config.disableAsync || false
        let mongooseConnection;
        let mongooseClient
        let amqpClient
        let amqpConnection
        try {
            mongooseConnection = await mongoose.connect(envConfig.dbConnectionURL, envConfig.dbAuthCredentials);
            mongoose.connection.on('error', err => {
                logger.error('Mongo Error', err)
                logger.error(err)
            })
            mongooseClient = mongooseConnection.connection.getClient()
            logger.info('Successfully connected to MongoDB');
        } catch (err) {
            logger.error('Could not connect to MongoDB', err)
            process.exit(1)
        }
    
        try {
            const connection = await createConnection(
                serviceName,
                handlers,
                disableAsync
            )
            amqpChannel = connection.amqpChannel
            amqpConnection = connection.amqpConnectionl
            logger.info('Successfully connected to RabbitMq')
        } catch (err) {
            logger.info('Could not connect to RabbitMq', err)
            process.exit(1)
        }

        const app = express()
    
        if (envConfig.env !== 'development' && envConfig.env !== 'test') {
            app.set('trust proxy', true)
        }

        app.use(
            helmet({
                // X-Content-Type-Options
                noSniff: true,
        
                // Referrer-Policy
                referrerPolicy: {
                    policy: 'strict-origin-when-cross-origin',
                },
        
                // HTTP Strict-Transport-Security
                hsts: {
                    maxAge: 16020400, // 186 days
                    includeSubDomains: true,
                    preload: true
                },
        
                // X-XSS-Protection
                xXssProtection: true,
                // xssFilter: true
            })
        )
        
        app.use(cookies());
        
        // parse json request body
        app.use(express.json({ limit: '50mb'}));
        app.use(express.urlencoded({ limit: '50mb', extended: true, parameterLimit: 50000 }));
        
        // parse urlencoded request body
        app.use(express.urlencoded({
            extended: true
        }));
        
        // sanitize request data
        app.use(xss());
        app.use(mongoSanitize());
        
        // gzip compression
        app.use(compression());

        if (!Object.prototype.hasOwnProperty.call(handlers, `${HEALTH_CHECK_PATH}`)) {
            app.route(`${HEALTH_CHECK_PATH}`).get(async (req, res) => {
                const traceId = req.headers['x-trace-id']
                res.status(200).send({
                    status: 'OK',
                    serviceName,
                    version: rootPackage.version,
                })
            })
        }

        Object.keys(handlers).forEach((handlerName) => {
            const routeMiddleware = handlers[handlerName].routeMiddleware || []
            const controller = async (req, res) => {
                const { handler } = handlers[handlerName];
                const traceId = req.headers['x-trace-id'];
                const taskId = req.headers['facebook-task-id'];

                const reqId = req.headers["req-id"];
                const sourceSystemName = req.headers["source-system-name"];
                const jwtHeaderToken = req.headers["x-jwt-key"];
                const { metadata, context } = req.body
                let data;
                if (typeof(req.body) === "text") {

                } else {
                    data = {...req.query, ...req.body}
                }
                const handlerResponse = await processTask({
                    serviceName,
                    handlerName,
                    handler,
                    taskType: "PROCESS",
                    taskId,
                    data,
                    logger,
                    metadata: {
                        ...metadata,
                        traceId,
                        reqId,
                        sourceSystemName,
                        version: rootPackage.version,
                        jwtHeaderToken
                    },
                    context,
                    req,
                    res,
                    channel: amqpChannel
                })
                res.status(handlerResponse?.status || 200).send(handlerResponse)
            }

            if (handlerName === HEALTH_CHECK_PATH || handlers[handlerName].method === "GET") {
                app.route(`/${handlerName}`).get(...routeMiddleware, controller)
            } else {
                app.route(`'/${handlerName}`).post(...routeMiddleware, validateMiddleware(handlers[handlerName].validator), controller)
            }
        })

        app.use(errorHandler);

        const server = app.listen(serverPort, () => {
            logger.info(`TASK_SERVER | ${serviceName} | Listening on port ${serverPort}`)
        })

        const closeServer = async () => {
            logger.info('Closing');
            if (!server) {
                return;
            }
    
            server.close(async () => {
                logger.info('Server closed')
                await mongoose.connection.close()
            })
        }
    
        const exitHandler = async () => {
            try {
                await closeServer()
            } catch (err) {
                logger.error('Server was closed so exiting the process now', err)
            }

            process.exit(1);
        }

        const unexpectedErrorHandler = error => {
            logger.error('Unexpected Error ', { err: error });
            exitHandler();
        }

        process.on('uncaughtException', unexpectedErrorHandler);
        process.on('unhandeledRejection', unexpectedErrorHandler);

        process.on('SIGTERM', () => {
            logger.warn('SIGTERM received');
            exitHandler();
        })

        process.on('SIGINT', () => {
            logger.warn('SIGINT received');
            exitHandler();
        })

    } catch (err) {
        logger.error('Unable to start server', {err})
        process.exit(1);
    }
}

module.exports = {
    startTaskServer
}