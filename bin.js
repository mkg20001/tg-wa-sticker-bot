#!/usr/bin/env node

'use strict'

const pino = require('pino')
const log = pino({name: 'tg-wa-sticker-bot'})

const os = require('os')
const fs = require('fs')
const prom = (fnc) => new Promise((resolve, reject) => fnc((err, res) => err ? reject(err) : resolve(res)))

const HELLO = `*This bot exports Telegram stickerpacks into WhatsApp \`.wastickers\` for StickerMaker*

Send me a sticker to convert the stickerpack
 \\* More features comming soon

Oh, and could you please...
 \\* Report bugs when you spot them: https://github.com/mkg20001/tg-wa-sticker-bot/issues
 \\* Donate: https://paypal.me/mkg20001
`

const core = require('teleutils')('wa-sticker-bot', {
  token: process.argv[2],
  helloMessage: HELLO,
  breakSymetry: true // parallelize
})

const {bot} = core
core.queue.init('process', 2)
core.queue.init('fetch', 3)
core.queue.init('convert', os.cpus().length)

const Packer = require('zip-stream')

const msgText = (params) => {
  return `Please be patient while the pack is being converted.
It could take up to 5 minutes.

Currently need to convert a total of ${params.packs - 1} other pack${(params.packs - 1) === 1 ? '' : 's'}
Estimated waiting time: ${params.packs * 60} seconds`
}

bot.on('sticker', async (msg) => {
  const _msg = () => msgText({packs: core.queue._queues.process.todo.length + core.queue._queues.process.working})
  const {chat: { id: chatId }, message_id: msgId} = await msg.reply.text(_msg(), {asReply: true})

  const intv = setInterval(async () => {
    await bot.editMessageText(chatId, msgId, _msg())
  }, 1000)

  const cleanup = async () => {
    clearInterval(intv)
    await bot.deleteMessage(chatId, msgId)
  }

  try {
    await core.queue('process', async () => convertPack(msg))
    await cleanup()
  } catch (err) {
    await cleanup()
    throw err
  }
})

const convertPack = async (msg) => {
  const set = await bot.getStickerSet(msg.sticker.set_name)
  const archive = new Packer() // OR new packer(options)

  let download = set.stickers.map(async (sticker, i) => core.queue('fetch', async () => {
    const outname = 'sticker' + i + '.webp'
    return {
      outname,
      fetched: await core.fetch.tg(sticker),
      sticker
    }
  }))

  const outPack = core.tmp('out.wastickers')

  // TODO: add archive.on('error')

  const ws = fs.createWriteStream(outPack.path)
  archive.pipe(ws)

  const converted = download.map(async (sticker) => {
    sticker = await sticker
    return core.queue('convert', async () => { // queue AFTER dl finish
      const out = core.tmp(sticker.outname)
      // padding https://stackoverflow.com/a/39775027/3990041 size https://stackoverflow.com/a/11920384/3990041
      await core.exec('convert', [sticker.fetched.path, '-define', 'webp:extent=100kb', '-alpha', 'set', '-resize', '512x512', '-background', 'transparent', '-gravity', 'center', '-extent', '512x512', out.path])
      return {
        out,
        name: sticker.outname,
        fetched: sticker.fetched
      }
    })
  })

  const cover = core.tmp('cover.png')
  await core.exec('convert', [(await download[0]).fetched.path, '-alpha', 'set', '-resize', '96x96', cover.path])
  await prom(cb => archive.entry(fs.readFileSync(cover.path), { name: 'icon.png' }, cb))
  cover.cleanup()

  for (let i = 0; i < converted.length; i++) {
    const {out, name, fetched} = await converted[i]
    await prom(cb => archive.entry(fs.readFileSync(out.path), { name }, cb))
    fetched.cleanup()
    out.cleanup()
  }

  await prom(cb => archive.entry(set.name, { name: 'author.txt' }, cb))
  await prom(cb => archive.entry(set.title, { name: 'title.txt' }, cb))
  archive.finish()
  await prom(cb => ws.once('close', cb))

  await msg.track('convert/sticker')
  await msg.reply.file(outPack.path, {fileName: set.title + '.wastickers', asReply: true})

  outPack.cleanup()
}

core.start()
