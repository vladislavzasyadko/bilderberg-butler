const express = require('express');

const config = require('../config.json')
const APIHandler = require('./api-handler');
const { handleWebhook } = require('./webhook-handler');
const { setHealth, getHealth } = require('../services/health');

class APIServer {
    constructor (app) {
        this.app = app;
        this.logger = require('../logger').child({ module: 'api-server' });

        this.express = express();

        this.api_handler = new APIHandler(this);

        this.express.use((req, res, next) => {
            this.logger.info(
                `Received [${req.method} : ${req.originalUrl}]`,
                { method: req.method, uri: req.originalUrl }
            );
            next();
        });

        this.express.get('/', (req, res) => {
            res.redirect(config.API_HOMEPAGE);
        });

        this.express.get('/health', (req, res) => {
            res.json(getHealth());
        })

        this.express.get('/health/:name', (req, res) => {
            if (req.params.name && Object.keys(this.app.health).includes(req.params.name)) {
                res.json({
                    [req.params.name]: getHealth(req.params.name)
                });
                return;
            }
            res.json(getHealth());
        });

        this.express.get('/discordredirect/:prefix/:serverid/:channelid', (req, res) => {
            if (req.params.serverid && req.params.channelid && req.params.prefix) {
                res.redirect(`discord://discord.com/${req.params.prefix}/${req.params.serverid}/${req.params.channelid}`);
                return;
            }
            res.sendStatus(404);
        })

        if (process.env.WEBHOOK_TELEGRAM_TOKEN) {
            this.setWebhookMiddleware('/webhook/:app/:telegram_chat_id', handleWebhook);
        }

        // This will need to be reworked
        // this.registerEndpoint('help');
        // this.registerEndpoint('calc');
        // this.registerEndpoint('ahegao');

        // if (process.env.COINMARKETCAP_TOKEN && config.COINMARKETCAP_API) {
        //     this.registerEndpoint('cur');
        // }
    }

    get currencies_list() {
        return this.app.currencies_list;
    }

    async start() {
        if (!process.env.PORT) {
            this.logger.warn(`Port for API wasn't specified, API is not started.`);
            return;
        }
        this._server = this.express.listen(process.env.PORT, () => {
            this.logger.info('API is ready');
            setHealth('api', 'ready');
        })
    }

    async stop() {
        if (!process.env.PORT) {
            return;
        }
        this.logger.info('Gracefully shutdowning API');
        this._server.close(err => {
            if (err) {
                this.logger.error(`Error while shutdowning API`, { error: err.stack || err });
            }
            setHealth('api', 'off');
        });
    }

    setWebhookMiddleware(uri, middleware) {
        this.express.use(uri, express.json());
        this.express.use(uri, middleware);
    }

    registerEndpoint(name) {
        if (typeof this.api_handler[name] === 'function') {
            this.express.get(`/command/${name}`, async (req, res) => this.api_handler[name](req, res))
        }
    }
}

module.exports = APIServer;