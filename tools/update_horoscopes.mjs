import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const OUTPUT = path.join(ROOT, 'public', 'data', 'horoscopes.json')
const HOROSCOPE_API = 'https://freehoroscopeapi.com/api/v1/get-horoscope/daily'
const API_NINJAS_HOROSCOPE = 'https://api.api-ninjas.com/v1/horoscope'
const TRANSLATE_API = 'https://api.mymemory.translated.net/get'
const API_NINJAS_API_KEY = process.env.API_NINJAS_API_KEY?.trim() ?? ''
const SIGNS = ['aries', 'taurus', 'gemini', 'cancer', 'leo', 'virgo', 'libra', 'scorpio', 'sagittarius', 'capricorn', 'aquarius', 'pisces']

function splitForTranslation(text, limit = 430) {
  const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [text]
  const chunks = []
  let chunk = ''
  for (const sentence of sentences) {
    const next = `${chunk} ${sentence}`.trim()
    if (next.length <= limit) chunk = next
    else {
      if (chunk) chunks.push(chunk)
      chunk = sentence.trim()
    }
  }
  if (chunk) chunks.push(chunk)
  return chunks
}

async function fetchJson(url, attempts = 3, extraHeaders = {}) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'Pogoda3310Widget/1.0', ...extraHeaders } })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.json()
    } catch (error) {
      lastError = error
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, attempt * 1200))
    }
  }
  throw lastError
}

async function translateToPolish(text) {
  const translated = []
  for (const chunk of splitForTranslation(text)) {
    const params = new URLSearchParams({ q: chunk, langpair: 'en|pl', mt: '1' })
    const result = await fetchJson(`${TRANSLATE_API}?${params}`)
    const output = result?.responseData?.translatedText
    if (typeof output !== 'string' || !output.trim()) throw new Error('Empty Polish translation')
    translated.push(output.trim())
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return translated.join(' ')
}

const signs = {}
let date = new Date().toISOString().slice(0, 10)
let fallbackCount = 0

for (const sign of SIGNS) {
  let response
  let text
  try {
    response = await fetchJson(`${HOROSCOPE_API}?sign=${sign}`)
    text = response?.data?.horoscope
    date = response?.data?.date ?? date
    if (typeof text !== 'string' || !text.trim()) throw new Error(`Missing primary horoscope for ${sign}`)
  } catch (primaryError) {
    if (!API_NINJAS_API_KEY) throw primaryError
    response = await fetchJson(
      `${API_NINJAS_HOROSCOPE}?zodiac=${sign}`,
      3,
      { 'X-Api-Key': API_NINJAS_API_KEY },
    )
    text = response?.horoscope
    date = response?.date ?? date
    fallbackCount += 1
  }
  if (typeof text !== 'string' || !text.trim()) throw new Error(`Missing horoscope for ${sign}`)
  signs[sign] = { en: text.trim(), pl: await translateToPolish(text.trim()) }
}

await mkdir(path.dirname(OUTPUT), { recursive: true })
await writeFile(OUTPUT, `${JSON.stringify({
  date,
  generatedAt: new Date().toISOString(),
  source: fallbackCount > 0
    ? 'Free Horoscope API + API Ninjas fallback'
    : 'Free Horoscope API',
  signs,
}, null, 2)}\n`, 'utf8')

console.log(`Updated ${OUTPUT} for ${date} (${SIGNS.length} signs, PL + EN; fallback signs: ${fallbackCount})`)
