const { version } = require('../../package.json');
const config = require('../config');

const swaggerDef = {
    openapi: '3.1.0',
    info: {
        title: 'Your title',
        description: 'description',
        version,
    },
    server: [
        {
            url: `http://localhost:${config.PORT}/v1`
        }
    ]
}

module.exports = swaggerDef;