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
  helloMessage: HELLO
})

const {bot} = core
core.queue.init('process', 2)
core.queue.init('fetch', 5)
core.queue.init('convert', os.cpus().length)

const Packer = require('zip-stream')

bot.on('sticker', async (msg) => {
  await msg.reply.text(`Please be patient while the pack is being converted. It could take up to 5 minutes.`, {asReply: true})

  await core.queue('process', async () => convertPack(msg))
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

  download = await Promise.all(download)

  const outPack = core.tmp('out.wastickers')

  // TODO: add archive.on('error')

  const ws = fs.createWriteStream(outPack.path)
  archive.pipe(ws)

  const cover = core.tmp('cover.png')
  await core.exec('convert', [download[0].fetched.path, '-alpha', 'set', '-resize', '96x96', cover.path])
  await prom(cb => archive.entry(fs.readFileSync(cover.path), { name: 'icon.png' }, cb))

  const converted = download.map(async (sticker) => core.queue('convert', async () => {
    const out = core.tmp(sticker.outname)
    await core.exec('convert', [sticker.fetched.path, '-alpha', 'set', '-resize', '512x512', out.path]) // TODO: add padding
    return {
      out,
      name: sticker.outname
    }
  }))

  for (let i = 0; i < converted.length; i++) {
    const {out, name} = await converted[i]
    await prom(cb => archive.entry(fs.readFileSync(out.path), { name }, cb))
  }

  await prom(cb => archive.entry(set.name, { name: 'author.txt' }, cb))
  await prom(cb => archive.entry(set.title, { name: 'title.txt' }, cb))
  archive.finish()
  await prom(cb => ws.once('close', cb))

  return msg.reply.file(outPack.path, {file_name: set.title + '.wastickers', asReply: true})
}

core.start()
