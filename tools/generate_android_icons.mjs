import { chromium } from 'playwright'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const svg = await readFile(path.join(root, 'public', 'icon.svg'))
const source = `data:image/svg+xml;base64,${svg.toString('base64')}`
const res = path.join(root, 'android', 'app', 'src', 'main', 'res')
const densities = {
  mdpi: 48,
  hdpi: 72,
  xhdpi: 96,
  xxhdpi: 144,
  xxxhdpi: 192,
}

const browser = await chromium.launch({ channel: 'msedge', headless: true })

try {
  for (const [density, size] of Object.entries(densities)) {
    const output = path.join(res, `mipmap-${density}`)
    await mkdir(output, { recursive: true })

    const page = await browser.newPage({ viewport: { width: size, height: size } })
    await page.setContent(`
      <style>*{box-sizing:border-box}html,body{width:100%;height:100%;margin:0;background:transparent}img{display:block;width:100%;height:100%}</style>
      <img src="${source}" alt="">
    `)
    await page.locator('img').evaluate((image) => image.decode())
    await page.screenshot({ path: path.join(output, 'ic_launcher.png'), omitBackground: true })
    await page.screenshot({ path: path.join(output, 'ic_launcher_round.png'), omitBackground: true })
    await page.close()

    const foregroundSize = Math.round(size * 2.25)
    const foregroundPage = await browser.newPage({ viewport: { width: foregroundSize, height: foregroundSize } })
    await foregroundPage.setContent(`
      <style>*{box-sizing:border-box}html,body{width:100%;height:100%;margin:0;background:transparent;display:grid;place-items:center}img{display:block;width:66.6667%;height:66.6667%}</style>
      <img src="${source}" alt="">
    `)
    await foregroundPage.locator('img').evaluate((image) => image.decode())
    await foregroundPage.screenshot({ path: path.join(output, 'ic_launcher_foreground.png'), omitBackground: true })
    await foregroundPage.close()
  }
} finally {
  await browser.close()
}
