const { InputFile, InlineKeyboard } = require('grammy');

const CLEAR_ERROR_MESSAGE_TIMEOUT = ++process.env.CLEAR_ERROR_MESSAGE_TIMEOUT || 10000;
/**
 * Turns Telegram context to an object that can be used as an input to a common command handler
 * @param {Object} ctx
 * @param {Integer} limit number of parsable args
 * @return {Interaction}
 * 
 * `limit` is tricky, it makes possible for argument to consist of multiple words
 * Example: `/foo bar baz bax`
 *   - if we set limit here to 1, we will limit the number 
 *     of args to 1 and this function will join all args with 
 *     spaces, therefore args = ['bar baz bax'].
 *   - if we set limit to 2, we will have 2 args as follows: 
 *     args = ['bar', 'baz bax'], and so on.
 *   - if we set limit to null, we will parse all words as standalone: 
 *     args = ['bar', 'baz', 'bax'].
 * 
 */
function commonizeContext(ctx, limit) {
    let args = [];

    // split all words by <space>
    args = ctx.message.text.replace(/ +/g, ' ').split(' ');

    // remove `/` from the name of the command
    args[0] = args[0].split('').slice(1).join('');

    // concat args to a single arg
    if (limit && (limit + 1) < args.length && limit > 0) {
        args[limit] = args.slice(limit).join(' ');
        args = args.slice(0, limit + 1);
    }

    // Form interaction object
    let interaction = {
        platform: 'telegram',
        command_name: args[0],
        ctx: ctx,
    };

    if (args.length > 1) {
        interaction.args = args.slice(1);
    }

    interaction.from = {
        id: ctx.from?.id,
        name: `${ctx.from?.first_name}${ctx.from?.last_name ? ` ${ctx.from.last_name}` : ''}`,
        username: ctx.from?.username
    }

    if (ctx.type === 'private') {
        interaction.space = interaction.from
        interaction.space.type = 'private'
    }
    else {
        interaction.space = {
            id: ctx.chat?.id,
            type: ctx.chat?.type,
            title: ctx.chat?.title
        }
    }

    interaction.id = ctx.message?.message_id;
    interaction.text = ctx.message?.text;
    
    return interaction;
}

/**
 * 
 * @param {import('grammy').Context} ctx 
 * @param {*} response 
 * @param {*} logger 
 * @returns 
 */
function replyWithText(ctx, response, logger) {
    logger.info(`Replying with text`, { response });

    return ctx.reply(
        response.text,
        {
            allow_sending_without_reply: true,
            reply_to_message_id: ctx.message?.reply_to_message?.message_id || ctx.message?.message_id,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
            ...response.overrides
        }
    ).then((message) => {
        logger.debug('Replied!', { message_id: message.message_id });
        if (CLEAR_ERROR_MESSAGE_TIMEOUT > 0 && response.type === 'error') {
            setTimeout(() => {
                if ((ctx.message.text || ctx.message.caption)?.split(' ') === 1) {
                    ctx.deleteMessage().catch(() => {});
                }
                ctx.api.deleteMessage(message.chat.id, message.message_id).catch(() => {});
            }, CLEAR_ERROR_MESSAGE_TIMEOUT)
        }
    }).catch(err => {
        logger.error(`Error while replying`, { error: err.stack || err});
        // Try again if only it wasn't an error message
        if (response.type !== 'error') {
            return replyWithText(
                ctx,
                {
                    type: 'error',
                    text: `Что-то случилось:\n<code>${err}</code>`
                },
                logger
            )
        }
    }).finally(() => {
        if (typeof response.callback === 'function') {
            response.callback();
        }
    });
}

function reply(ctx, response, logger) {
    const reply_methods = {
        'audio': ctx.replyWithAudio.bind(ctx),
        'animation': ctx.replyWithAnimation.bind(ctx),
        'chat_action': ctx.replyWithChatAction.bind(ctx),
        'contact': ctx.replyWithContact.bind(ctx),
        'dice': ctx.replyWithDice.bind(ctx),
        'document': ctx.replyWithDocument.bind(ctx),
        'game': ctx.replyWithGame.bind(ctx),
        'invoice': ctx.replyWithInvoice.bind(ctx),
        'location': ctx.replyWithLocation.bind(ctx),
        'media_group': ctx.replyWithMediaGroup.bind(ctx),
        'photo': ctx.replyWithPhoto.bind(ctx),
        'poll': ctx.replyWithPoll.bind(ctx),
        'sticker': ctx.replyWithSticker.bind(ctx),
        'venue': ctx.replyWithVenue.bind(ctx),
        'video': ctx.replyWithVideo.bind(ctx),
        'video_note': ctx.replyWithVideoNote.bind(ctx),
        'voice': ctx.replyWithVoice.bind(ctx),
    };

    const sendReply = reply_methods[response.type];

    if (response?.overrides?.followup && !response?.overrides?.reply_markup) {
        const { text, url } = response.overrides.followup;
        response.overrides.reply_markup = new InlineKeyboard().url(text, url);
    }

    if (!sendReply) {
        return replyWithText(ctx, response, logger);
    }

    let media;

    if (response.filename) {
        logger.info(`Replying with file of type: ${response.type}`);
        media = new InputFile(response.media, response.filename);
    }
    else {
        logger.info(`Replying with media of type: ${response.type}`);
        media = response.media;
    }

    return sendReply(
        media,
        {
            caption: response.text,
            allow_sending_without_reply: true,
            reply_to_message_id: ctx.message?.reply_to_message?.message_id || ctx.message?.message_id,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
            ...response.overrides
        }
    ).then((message) => {
        logger.debug('Replied!', { message_id: message.message_id});
    }).catch(err => {
        logger.error(`Error while replying`, { error: err.stack || err});
        return replyWithText(
            ctx,
            {
                type: 'error',
                text: `Что-то случилось:\n<code>${err}</code>`
            },
            logger
        )
    }).finally(() => {
        if (typeof response.callback === 'function') {
            response.callback();
        }
    });
}

/**
 * 
 * @param {*} ctx 
 * @param {*} handler
 */
function handleCommand(ctx, handler, definition) {
    const common_interaction = commonizeContext(ctx, definition?.limit);
    const log_meta = {
        module: 'telegram-common-interface-handler',
        command_name: common_interaction.command_name,
        platform: common_interaction.platform,
        interaction: common_interaction
    }
    const logger = require('../logger').child(log_meta);
    common_interaction.logger = logger.child({ ...log_meta, module: `common-handler-${common_interaction.command_name}` });

    logger.info(`Received command: ${common_interaction.text}`);
    handler(common_interaction)
    .then(response => {
        return reply(ctx, response, logger);
    }).catch((err) => {
        logger.error(`Error while handling`, { error: err.stack || err });
        replyWithText(
            ctx,
            {
                type: 'error',
                text: `Что-то случилось:\n<code>${err}</code>`
            },
            logger
        )
    });
}

async function getLegacyResponse(ctx, handler, definition) {
    const common_interaction = commonizeContext(ctx, definition?.limit);
    const log_meta = {
        module: 'telegram-common-interface-handler',
        command_name: common_interaction.command_name,
        platform: common_interaction.platform,
        interaction: common_interaction
    }
    const logger = require('../logger').child(log_meta);
    common_interaction.logger = logger.child({ ...log_meta, module: `common-handler-${common_interaction.command_name}` });

    logger.info(`Received command: ${common_interaction.text}`);
    let response = await handler(common_interaction);

    if (response?.overrides?.followup && !response?.overrides?.reply_markup) {
        const { text, url } = response.overrides.followup;
        response.overrides.reply_markup = new InlineKeyboard().url(text, url);
    }

    return [
        response.type === 'error' ? response.text : null,
        response.type === 'text' ? response.text : response,
        null,
        response.overrides
    ];
}

module.exports = {
    commonizeContext,
    handleCommand,
    getLegacyResponse
}
