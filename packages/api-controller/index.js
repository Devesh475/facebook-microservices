const { startTaskServer } = require('')
startTaskServer(API_CONTROLLER_SERVICE_NAME, {
    port: 5001,//SERVICE_MAP[API_CONTROLLER_SERVICE_NAME].port,
    middlewares: [],
    disableAsync: true
}, {
    'mock': {
        handler: () => {
            console.log("Hello from mock endpoint")
        },
        validator: () => {
            console.log("Hello from validator")
        }
    }
})