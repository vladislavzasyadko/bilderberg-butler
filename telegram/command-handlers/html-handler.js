const GrammyTypes = require('grammy');

/**
 * `/html` command handler
 * @param {GrammyTypes.Context} input
 * @returns {[String | null, String | null]}
 */

async function html(input) {
    let text = require('./utils').parseArgs(input, 1)[1].trim();
    if (!text) {
        return [`Для того чтобы получить текст, нужно дать текст размеченный HTML`]
    }
    return [null, text, text];
}

module.exports = {
    html,
}
