const { OpenAI } = require('openai');
const { default: axios } = require('axios');

const logger = require('../logger').child({ module: 'chatgpt-handler' });

// const { Converter: MDConverter } = require('showdown');

// const mdConverter = new MDConverter({
//     noHeaderId: 'true',
//     strikethrough: 'true'
// });

/**
 * ChatGPT
 * @namespace ChatGPT
 */

/** 
 * Model name
 * @typedef {('gpt-3.5-turbo-16k' | 'gpt-4' | 'gpt-4-32k' | 'gpt-4-vision-preview')} Model
 * @memberof ChatGPT
 */
/** 
 * Chat member role name
 * @typedef {('system' | 'assistant' | 'user')} NodeRole
 * @memberof ChatGPT
 */
/** 
 * Complex structure for ChatGPT content
 * @typedef {{type: 'text', text: string}} ComplexContentText
 * @typedef {{type: 'image_url', image_url: string}} ComplexContentImage
 * @typedef {(ComplexContentText | ComplexContentImage)} ComplexContent
 * @memberof ChatGPT
 */
/** 
 * GPT Message content
 * @typedef {(string | ComplexContent[])} NodeContent
 * @memberof ChatGPT
 */
/** 
 * @typedef {import('./telegram-client').TelegramInteraction} TelegramInteraction
 * @memberof ChatGPT
 */
/** 
 * @typedef {import('@grammyjs/files').FileFlavor<import('grammy').Context>} GrammyContext
 * @memberof ChatGPT
 */
/**
 * @typedef {import('grammy/types').Message} TelegramMessage
 * @memberof ChatGPT
 */
/** 
 * Message, recognisable by ChatGPT
 * @typedef {{
 *  role: NodeRole,
 *  content: NodeContent,
 *  name: (string | null)
 * }} NodeMessage
 * @memberof ChatGPT
 */
/**
 * Full context node data
 * @typedef {{
 *  role: NodeRole,
 *  content: NodeContent,
 *  name: string,
 *  message_id: string,
 *  prev_message_id: (string | null),
 *  model: (Model | null),
 *  name: (string | null)
 * }} NodeRawData
* @memberof ChatGPT
*/

/** 
 * @typedef {[null | string, null | string | any, null | function, any]} CommandResponse
 * @memberof ChatGPT
 */

/** 
 * List of available models
 * @type {Model[]}
 * @memberof ChatGPT
 */
const models = [
    'gpt-3.5-turbo-16k',
    'gpt-4',
    'gpt-4-32k',
    'gpt-4-vision-preview'
];

const max_tokens = {
    'gpt-3.5-turbo-16k': undefined,
    'gpt-4': undefined,
    'gpt-4-32k': undefined,
    'gpt-4-vision-preview': 4096,
}
/** 
 * @type {Model}
 * @memberof ChatGPT
 */
const CHAT_MODEL_NAME = models.includes(process.env.GPT_MODEL) ? process.env.GPT_MODEL : 'gpt-3.5-turbo-16k';

const DEFAULT_SYSTEM_PROMPT = `you are a chat-assistant\nanswer should not exceed 4000 characters`;

/**
 * Convert Markdown based text to HTML
 * @param {string} input
 * @return {string}
 * @memberof ChatGPT
 */
function prepareText(input) {
    /** Needs to avoid replacing inside code snippets */
    let res = input
        .replace(/&/gm, '&amp;')
        .replace(/>/gm, '&gt;')
        .replace(/</gm, '&lt;');

    // Replace code blocks with language specification
    res = res.replace(/```(\S*)\n([^]*?)\n```/g, `<pre><code class='$1'>$2</code></pre>`);

    // Replace inline code blocks
    res = res.replace(/`([^`]*?)`/g, '<code>$1</code>');
    /** too aggressive
     *  let res = mdConverter
     *     .makeHtml(input)
     *     .replace(/<\/?p>/gm, '');
     */
    return res;
}

/**
 * Get text from telegram message
 * @param {import('grammy/types').Message} message 
 * @returns {(string | null)}
 * @memberof ChatGPT
 */
function getText(message) {
    return message?.text || message?.caption || null;
}

/**
 * Get content of the message, will return either text or an array
 * @param {GrammyContext}
 * @param {'text' | 'vision'} type
 * @param {TelegramMessage} message
 * @returns {Promise<NodeContent>}
 * @memberof ChatGPT
 */
async function getContent({ api, message: c_message }, type = 'text', message = c_message) {
    if (type === 'vision' && message.photo?.[0]) {
        const [file_buffer, content_type] = 
            await api.getFile(message.photo
                .sort((p1, p2) => (p2.height + p2.width) - (p1.height + p1.width))[0].file_id)
            .then(f => f.getUrl())
            .then(file_path => axios.get(
                file_path,
                { 
                    responseType: 'arraybuffer',
                }
            ))
            .then(({ data, headers }) => [
                Buffer.from(data).toString('base64'),
                headers['Content-Type'] || 'image/jpeg'
            ])
            .catch(err => {
                logger.error('Failed get image as buffer', { error: err.stack || err });
                return [];
            });
        if (!(file_buffer || content_type)) {
            return getText(message);
        }
        /** @type {ComplexContent[]} */
        const content = [{
            type: 'image_url',
            image_url: `data:${content_type};base64,${file_buffer}`
        }];

        if (message.caption) {
            content.push({
                type: 'text',
                text: message.caption
            });
        }

        return content;
    }
    return getText(message);
}

/**
 * Get model type based on model name
 * @param {Model} model 
 * @returns {'vision' | 'text'}
 * @memberof ChatGPT
 */
function getModelType(model) {
    return model.includes('vision') ? 'vision' : 'text';
}

/**
 * @class
 * @memberof ChatGPT
 */
class ContextNode {
    /**
     * @param {{
     *  role: NodeRole,
     *  content: NodeContent,
     *  message_id: string | string,
     *  prev_node: ContextNode | null,
     *  name: string | null,
     *  model: Model | null
     * }} 
     */
    constructor({ role, content, message_id, prev_node = null, name = null, model = null } = {}) {
        /** @type {string} */
        this.role = role;

        /** @type {NodeContent} */
        this.content = content;

        /** @type {Set<ContextNode>} */
        this.children = new Set();
        
        if (name) {
            /** @type {string | undefined} */
            this.name = name?.replace(/ +/g, '_')?.replace(/[^a-zA-Z0-9_]/g, '')?.slice(0, 64);
        };

        if (message_id) {
            /** @type {string | undefined} */
            this.message_id = message_id;
        };
        if (prev_node) {
            /** @type {ContextNode | undefined} */
            this.prev_node = prev_node;
        }
        if (model) {
            /** @type {Model | undefined} */
            this.model = model;
        }

    }

    /**
     * @param {ContextNode | null}
     */
    set prev_node(node) {
        this._prev_node?.removeChild(this);
        this._prev_node = node;
        node?.addChild(this);
    }

    /**
     * @returns {ContextNode | null}
     */
    get prev_node() {
        return this._prev_node;
    }

    /**
     * Add child to the set
     * @param {ContextNode} node 
     */
    addChild(node) {
        this.children.add(node);
    }

    /**
     * Remove child from set
     * @param {ChildNode} node 
     */
    removeChild(node) {
        this.children.delete(node)
    }

    /**
     * Get nodes data applicable as context
     * @returns {NodeMessage}
     */
    getMessage() {
        const message = {
            role: this.role,
            content: this.content,
        };
        if (this.name) message.name = this.name;
        return message;
    }

    /**
     * Get raw data of the node
     * @returns {NodeRawData}
     */
    getRawData() {
        const data = {
            role: this.role,
            content: Array.isArray(this.content) ?
                this.content.map(c => 
                    c.image_url.startsWith('data:') ?
                    {...c, image_url: '...buffer...'} :
                    c
                ) :
                this.content,
            message_id: this.message_id,
        };
        if (this.prev_node) data.prev_message_id = this.prev_node.message_id;
        if (this.model) data.model = this.model;
        if (this.name) data.name =  this.name;
        return data;
    }
}

/**
 * @class
 * @memberof ChatGPT
 */
class ContextTree {
    /**
     * 
     * @param {string | null} system_prompt 
     * @param {Model | null} model 
     */
    constructor(system_prompt, model) {
        /** @type {Map<string, ContextNode>} */
        this.nodes = new Map();

        /** @type {ContextNode} */
        this.root_node = new ContextNode({
            role: 'system',
            content: system_prompt || DEFAULT_SYSTEM_PROMPT,
            model: model || CHAT_MODEL_NAME
        });
    }

    /**
     * Get Node by message_id
     * @param {string} message_id 
     * @returns {ContextNode | null}
     */
    getNode(message_id) {
        return this.nodes.has(message_id) ? this.nodes.get(message_id) : null;
    }

    /**
     * Creates new node and appends to the tree either by the prev_message_id or to the root node
     * @param {{ role: NodeRole, content: NodeContent, message_id: string, prev_message_id: string, name: string }}
     */
    appendNode({ role, content, message_id, prev_message_id, name } = {}) {
        let prev_node = this.root_node;

        if (prev_message_id && this.checkNodeExists({ message_id: prev_message_id })) {
            prev_node = this.nodes.get(prev_message_id);
        }

        this.nodes.set(message_id, new ContextNode({ role, content, message_id, prev_node, name }));
    }

    /**
     * Checks if node exists either by node's message_id or provided message_id
     * @param {{ node: ContextNode | null, message_id: string | null }} 
     * @returns {boolean}
     */
    checkNodeExists({ node = null, message_id = null } = {}) {
        if (node) {
            message_id = node.message_id;
        }

        return this.nodes.has(message_id);
    }

    /**
     * Gets the context of the message as an array
     * @param {string} message_id 
     * @param {number} limit 
     * @returns {NodeMessage[]}
     */
    getContext(message_id, limit = 30) {
        if (!this.checkNodeExists({ message_id })) {
            return [this.root_node.getMessage()]
        }

        let context = [];

        let last_node = this.getNode(message_id);

        while (last_node && context.length <= limit) {
            context.unshift(last_node.getMessage());
            last_node = last_node.prev_node;
        }

        if (context[0].role !== this.root_node.role) {
            context.unshift(this.root_node.getMessage());
        }

        return context;
    }


    /**
     * Gets the raw context of the message as an array
     * @param {string | null} message_id 
     * @returns {NodeRawData[]}
     */
    getRawContext(message_id = null) {
        const raw_context = [];

        if (!this.checkNodeExists({ message_id })) {
            return raw_context;
        }

        let last_node = this.getNode(message_id);

        while (last_node) {
            raw_context.unshift(last_node.getRawData());
            last_node = last_node.prev_node;
        }

        return raw_context;
    }

    /**
     * Get node by id and remove it from tree (relinks node's children to node's parent)
     * @param {string} message_id
     * @returns {ContextNode | null}
     */
    detachNode(message_id) {
        const node = this.nodes.get(message_id);
        node?.children?.forEach(child => {
            child.prev_node = node.prev_node;
            node.children.delete(child);
        });
        return this.nodes.delete(message_id) ? node : null;
    }

    /**
     * Detach the branch where node with specified message_id exists, returns the child of a root node and a map of nodes
     * @param {string} message_id
     * @returns {{node: ContextNode, branch: Map<string, ContextNode>}}
     */
    detachBranch(message_id) {
        if (!this.checkNodeExists({ message_id })) {
            return {};
        }

        let branch_root = null;
        let branch = new Map();

        // going upwards
        let node = this.getNode(message_id);
        while (node.prev_node.role !== 'system') {
            node = node.prev_node;
        }

        // last prev_node is right under root
        branch_root = node;
        branch_root.prev_node = null;
        branch.set(branch_root.message_id, branch_root);
        this.nodes.delete(branch_root.message_id);

        // processing downwards
        const processChildren = (node) => {
            node.children.forEach(child => {
                branch.set(child.message_id, child);
                this.nodes.delete(child.message_id);
                if (child.children.size) processChildren(child);
            });
        };

        processChildren(branch_root);
        return { node: branch_root, branch };
    }

    /**
     * Append branch to the tree
     * @param {ContextNode} node leading node (that should be attached to root)
     * @param {Map<string, ContextNode>} branch map of nodes including {@link node}
     */
    appendBranch(node, branch) {
        node.prev_node = this.root_node;
        branch.forEach((node, message_id) => {
            this.nodes.set(message_id, node);
        });
    }

    /**
     * Get type of the model used for the tree
     * @returns {'text' | 'vision'}
     */
    getModelType() {
        return getModelType(this.root_node.model);
    }
}

/**
 * @class
 * @memberof ChatGPT
 */
class ChatGPTHandler {
    constructor() {
        /** @type {Logger} */
        this.logger = logger;

        /** @type {OpenAI} */
        this.openAI = new OpenAI({
            apiKey: process.env.OPENAI_TOKEN,
            organization: 'org-TDjq9ytBDVcKt4eVSizl0O74'
        });

        /** @type {Map<string, Map<Model, ContextTree>>} */
        this.context_trees_map = new Map();
    }

    /**
     * Find tree by chat and message_id
     * @param {string} chat_id 
     * @param {string} message_id 
     * @returns {ContextTree | null}
     */
    _findContextTree(chat_id, message_id) {
        const trees = this.context_trees_map.get(chat_id);
        if (!trees) return null;
        for (const tree of trees.values()) {
            if (tree.checkNodeExists({ message_id })) return tree;
        }
        return null;
    }

    /**
     * Creates context tree for specified chat and model if needed
     * @param {string} chat_id 
     * @param {Model} model 
     */
    _createContextTree(chat_id, model = CHAT_MODEL_NAME) {
        if (!this.context_trees_map.has(chat_id)) {
            this.context_trees_map.set(chat_id, new Map());
        }
        if (!this.context_trees_map.get(chat_id).has(model)) {
            const system_prompt = chat_id === -1001625731191 ? `${DEFAULT_SYSTEM_PROMPT}\npeople in this chat: Никита, Danila, Миша, Влад` : null;
            this.context_trees_map.get(chat_id).set(model, new ContextTree(system_prompt, model))
        }
    }

    /**
     * Get a context tree fitting the specified arguments
     * @param {string} chat_id
     * @param {{message_id: string | null, model: Model}} 
     * @returns {ContextTree}
     */
    _getContextTree(chat_id, { message_id = null, model = CHAT_MODEL_NAME } = {}) {
        if (!chat_id) {
            throw new Error('No chat_id specified to get context tree');
        }

        if (message_id) {
            let tree = this._findContextTree(chat_id, message_id);
            if (tree) return tree;
        }
    
        this._createContextTree(chat_id, model);
    
        return this.context_trees_map.get(chat_id).get(model);
    }

    /**
     * Get array of trees associated with chat
     * @param {string} chat_id 
     * @returns {ContextTree[]}
     */
    _getChatTrees(chat_id) {
        return this.context_trees_map.has(chat_id) ? [...this.context_trees_map.get(chat_id).values()] : [];
    }

    /**
     * Move branch from one tree to another
     * @param {string} message_id 
     * @param {ContextTree} source_context_tree 
     * @param {ContextTree} destination_context_tree 
     */
    _transferContextBranch(message_id, source_context_tree, destination_context_tree) {
        const { node, branch } = source_context_tree.detachBranch(message_id);
        destination_context_tree.appendBranch(node, branch);
    }

    /**
     * Makes an OpenAI API request with provided context and returnes response as text
     * @param {TelegramInteraction} interaction 
     * @param {NodeMessage[]} context 
     * @param {ContextTree} context_tree 
     * @param {string} prev_message_id 
     * @returns {CommandResponse}
     */
    _replyFromContext(interaction, context, context_tree, prev_message_id) {
        interaction.context.replyWithChatAction('typing');

        const continiousChatAction = setInterval(() => {
            interaction.context.replyWithChatAction('typing');
        }, 5000);

        return this.openAI.chat.completions.create({
            model: context_tree.root_node.model,
            messages: context,
            max_tokens: max_tokens[context_tree.root_node.model]
        }).then((data) => {
            if (!data) {
                this.logger.warn('No response to ChatGPT Completion', { data });
                return ['ChatGPT сломался, попробуй спросить позже', null, null, { reply_to_message_id: prev_message_id }];
            }

            if (!data?.choices?.length) {
                this.logger.warn('No choices for ChatGPT Completion');
                return ['У ChatGPT просто нет слов', null, null, { reply_to_message_id: prev_message_id }];
            }

            return [
                null,
                prepareText(data.choices[0].message.content),
                ({ message_id: new_message_id, text }) => {
                    context_tree.appendNode({
                        role: 'assistant',
                        name: interaction.context.me.first_name,
                        content: text,
                        message_id: new_message_id,
                        prev_message_id
                    });
                },
                { reply_to_message_id: prev_message_id }
            ];
        }).catch(err => {
            if (err?.response) {
                this.logger.error(`API Error while getting ChatGPT Completion`, { error: err.response?.data || err.response?.status || err})
            }
            else {
                this.logger.error(`Error while getting ChatGPT Completion`, { error: err.stack || err });
            }
            return ['ChatGPT отказывается отвечать, можешь попробовать ещё раз, может он поддастся!', null, null, { reply_to_message_id: prev_message_id }];
        }).finally(() => {
            clearInterval(continiousChatAction);
        });
    }

    /**
     * Answer request received via reply
     * @param {TelegramInteraction} interaction
     * @returns {Promise}
     */
    async answerReply(interaction) {
        if (
            !interaction.context?.message?.reply_to_message
            || !getText(interaction.context?.message) 
            || getText(interaction.context?.message).startsWith('/ ')
        ) {
            return;
        }

        const logger = this.logger.child({...interaction.logger.defaultMeta, ...this.logger.defaultMeta});

        logger.info(`Processing ChatGPT request received with a reply`);
        
        let prev_message_id = interaction.context.message.reply_to_message.message_id;

        const context_tree = this._getContextTree(interaction.context.chat.id, { message_id: prev_message_id });
        const model_type = context_tree.getModelType();
        
        if (!context_tree.checkNodeExists({ message_id: prev_message_id })) {
            const content = await getContent(interaction.context, model_type, interaction.context.message.reply_to_message)
                .catch(err => {
                    interaction.logger.error('Failed to acquire content for reply message', { error: err.stack || err});
                    return getText(interaction.context.message.reply_to_message);
                });

            if (content) {
                context_tree.appendNode({ role: 'assistant', content, message_id: prev_message_id, name: interaction.context.me.first_name });
            }
            else {
                prev_message_id = null;
            }
        }

        const { message_id, from: { first_name: author } } = interaction.context.message;

        // appending user's request to the tree
        {
            const content = await getContent(interaction.context, model_type)
                .catch(err => {
                    interaction.logger.error('Failed to acquire content for message', { error: err.stack || err });
                    return getText(interaction.context.message);
                });
    
            context_tree.appendNode({ role: 'user', content, message_id, prev_message_id, name: author });
        }

        const context = context_tree.getContext(message_id);

        return this._replyFromContext(interaction, context, context_tree, message_id)
            .then(([err, response, callback = () => {}, overrides]) => {
                return interaction._reply(response || err, overrides)
                    .then(callback)
                    .catch(err => {
                        this.logger.error('Unprecedent error, it should have been already caught', { error: err.stack || err })
                    });
            });
    }

    /**
     * Respond with file containing context of the message
     * @param {GrammyContext} interaction 
     * @returns {CommandResponse}
     */
    async handleContextRequest(interaction) {
        if (!interaction?.message?.reply_to_message) {
            return ['Эта команда работает только при реплае на сообщение'];
        }
        
        const message_id = interaction.message.reply_to_message.message_id;

        const context_tree = this._getContextTree(interaction.chat.id, { message_id });

        const raw_context = context_tree.getRawContext(message_id);

        if (!raw_context.length) {
            return ['Для этого сообщения нет контекста'];
        }

        try {
            const context_message = {
                type: 'document',
                filename: `context_${message_id}.json`,
                media: Buffer.from(JSON.stringify(raw_context, null, 2)),
                text: 'Контекст'
            };

            return [null, context_message];
        }
        catch (err) {
            this.logger.error('Error while sending context', { error: err.stack || err });
            return [`Ошибка во время отправки контекста:\n<code>${err.message}</code>`];
        }
    }

    /**
     * Respond with file containing context trees of the chat
     * @param {GrammyContext} interaction 
     * @returns {CommandResponse}
     */
    async handleTreeRequest(interaction) {
        const context_trees = this._getChatTrees(interaction.chat.id);
        
        if (!context_trees.length) {
            return ['Пока деревьев нет.'];
        }

        try {
            const nodes = context_trees.map(tree => [...tree.nodes.values()]);

            const nodes_message = {
                type: 'document',
                filename: 'nodes.json',
                media: Buffer.from(JSON.stringify(nodes, null, 2)),
                text: 'Дерево'
            };

            return [null, nodes_message];
        }
        catch (err) {
            this.logger.error('Error while generating nodes tree', { error: err.stack || err });
            return [`Ошибка во время генерирования дерева контекста:\n<code>${err.message}</code>`];
        }
    }

    /**
     * Respond with ChatGPT response based on provided model, content of the replied message and/or text provided with the command
     * @param {GrammyContext} interaction_context 
     * @param {TelegramInteraction} interaction 
     * @param {Model} model 
     * @returns {Promise}
     */
    async handleAnswerCommand(interaction_context, interaction, model = CHAT_MODEL_NAME) {
        const command_text = interaction_context.message.text.split(' ').slice(1).join(' ');
        const model_type = getModelType(model);

        if ((
                (
                    getModelType(model) === 'text' 
                    && !(getText(interaction_context.message.reply_to_message))
                ) || (
                    getModelType(model) === 'vision' 
                    && !(interaction_context.message.reply_to_message?.photo?.length 
                    || getText(interaction_context.message.reply_to_message))
                )
            ) && !command_text.length)
            {
            return ['Отправь эту команду как реплай на другое сообщение или напишите запрос в сообщении с командой, чтобы получить ответ.'];
        }

        let context_tree = this._getContextTree(interaction_context.chat.id, { model });

        let prev_message_id = null;
        let message_id = null;
        let author = null;

        if (interaction_context.message.reply_to_message) {
            ({ message_id, from: { first_name: author } } = interaction_context.message.reply_to_message);
            context_tree = this._getContextTree(interaction_context.chat.id, { message_id, model })
            const content = await getContent(interaction_context, model_type, interaction_context.message.reply_to_message);
            if (typeof content === 'string' && model_type === 'vision') {
                return ['Не смог обработать картинку, попробуй позже'];
            }
            else if (content.length) {
                if (!context_tree.checkNodeExists({ message_id })) {
                    context_tree.appendNode({
                        role: (command_text?.length && interaction_context.from.id === interaction_context.me.id) ? 'assistant' : 'user',
                        content,
                        message_id: message_id,
                        name: author
                    });
                }
                else if (context_tree.getModelType() !== model_type) {
                    context_tree.getNode(message_id).content = content;
                }
            }
        }

        if (command_text?.length) {
           prev_message_id = message_id;
           ({ message_id, from: { first_name: author } } = interaction_context.message);
           context_tree.appendNode({
               role: 'user',
               content: command_text,
               message_id: message_id,
               prev_message_id,
               name: author
           });
        }

        if (context_tree.root_node.model !== model) {
            const new_tree = this._getContextTree(interaction_context.chat.id, { model });
            this._transferContextBranch(message_id, context_tree, new_tree);
            context_tree = new_tree;
        }

        const context = prev_message_id ? context_tree.getContext(message_id, 2) : context_tree.getContext(message_id);
        // fetch only messages refered by this command
        // const gpt_context = prev_message_id ? context_tree.getContext(message_id, 2) : context_tree.getContext(message_id, 1);

        return this._replyFromContext(interaction, context, context_tree, message_id);
    }

    /**
     * Change the system prompt for the chat's context trees
     * @param {TelegramInteraction} context 
     * @returns {ComplexContent}
     */
    async handleAdjustSystemPrompt(context) {
        const new_system_prompt = context.message.text.split(' ').slice(1).join(' ');
        
        const context_tree = this._getContextTree(context.chat.id);
        
        if (!new_system_prompt) {
            return [`Нужен не пустой системный промпт.\nПо умолчанию: <code>${DEFAULT_SYSTEM_PROMPT}</code>\nСейчас: <code>${context_tree.root_node.content}</code>`];
        }

        context_tree.root_node.content = new_system_prompt;

        return [null, 'Обновил'];
    }

    /**
     * Answer request received by DM
     * @param {TelegramInteraction} interaction 
     * @returns {Promise}
     */
    async answerQuestion(interaction) {
        if (!getText(interaction.context.message)) {
            return;
        }

        const logger = this.logger.child({...interaction.logger.defaultMeta, ...this.logger.defaultMeta});
        
        logger.info(`Processing ChatGPT request received by direct message`);

        const context_tree = this._getContextTree(interaction.context.chat.id);
        const model_type = context_tree.getModelType();

        const {
            message_id,
            from: { first_name: author }
        } = interaction.context.message;

        if (!context_tree.checkNodeExists({ message_id })) {
            const content = await getContent(interaction.context, model_type);

            context_tree.appendNode({ role: 'user', content, message_id, name: author });
        }

        const context = context_tree.getContext(message_id);

        return this._replyFromContext(interaction, context, context_tree, message_id)
            .then(([err, response, callback = () => {}, overrides]) => {
                return interaction._reply(response || err, overrides)
                    .then(callback)
                    .catch(err => {
                        this.logger.error('Unprecedent error, it should have been already caught', { error: err.stack || err })
                    });
            });
    }

    /**
     * Proxy to {@link ChatGPTHandler#handleAnswerCommand handleAnswerCommand}, mainly used to specify model
     * @param {Model} model 
     * @param {GrammyContext} context 
     * @param {TelegramInteraction} interaction 
     * @returns {Promise}
     */
    async handleModeledAnswerCommand(model, context, interaction) {
        return await this.handleAnswerCommand(context, interaction, model);
    }
}

module.exports = new ChatGPTHandler();
