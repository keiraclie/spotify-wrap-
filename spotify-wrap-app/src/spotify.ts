import type { RankedArtist, YearRecap } from './recap'

export interface GenreShare {
  name: string
  share: number
}

export interface SuggestedArtist {
  name: string
  genres: string[]
  spotifyUrl: string
}

export interface SpotifyDiscovery {
  genres: GenreShare[]
  artists: SuggestedArtist[]
}

interface SpotifyArtist {
  id: string
  name: string
  genres: string[]
  popularity?: number
  external_urls?: { spotify?: string }
}

interface ArtistSearchResponse {
  artists: { items: SpotifyArtist[] }
}

const AUTH_ENDPOINT = 'https://accounts.spotify.com/authorize'
const TOKEN_ENDPOINT = 'https://accounts.spotify.com/api/token'
const API_ENDPOINT = 'https://api.spotify.com/v1'
const VERIFIER_KEY = 'side-a-spotify-verifier'
const STATE_KEY = 'side-a-spotify-state'
const CLIENT_ID_KEY = 'side-a-spotify-client-id'

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function randomBase64Url(byteLength: number): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)))
}

export function getSpotifyRedirectUri(): string {
  return `${window.location.origin}/`
}

export async function beginSpotifyAuthorization(clientId: string, popup: Window): Promise<void> {
  const verifier = randomBase64Url(64)
  const state = randomBase64Url(24)
  const challengeBytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  const challenge = encodeBase64Url(new Uint8Array(challengeBytes))

  sessionStorage.setItem(VERIFIER_KEY, verifier)
  sessionStorage.setItem(STATE_KEY, state)
  sessionStorage.setItem(CLIENT_ID_KEY, clientId)

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: getSpotifyRedirectUri(),
    state,
    code_challenge_method: 'S256',
    code_challenge: challenge,
  })

  popup.location.assign(`${AUTH_ENDPOINT}?${params.toString()}`)
}

export async function exchangeSpotifyCode(code: string, returnedState: string): Promise<string> {
  const expectedState = sessionStorage.getItem(STATE_KEY)
  const verifier = sessionStorage.getItem(VERIFIER_KEY)
  const clientId = sessionStorage.getItem(CLIENT_ID_KEY)
  sessionStorage.removeItem(STATE_KEY)
  sessionStorage.removeItem(VERIFIER_KEY)
  sessionStorage.removeItem(CLIENT_ID_KEY)

  if (!expectedState || returnedState !== expectedState || !verifier || !clientId) {
    throw new Error('Spotify sign-in could not be verified. Please try connecting again.')
  }

  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      grant_type: 'authorization_code',
      code,
      redirect_uri: getSpotifyRedirectUri(),
      code_verifier: verifier,
    }),
  })

  if (!response.ok) {
    throw new Error('Spotify could not complete sign-in. Check your Client ID and redirect URI.')
  }

  const tokenResult: { access_token?: string } = await response.json()
  if (!tokenResult.access_token) throw new Error('Spotify did not return an access token.')
  return tokenResult.access_token
}

function normalizeName(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
}

async function spotifyGet<T>(path: string, accessToken: string): Promise<T> {
  const response = await fetch(`${API_ENDPOINT}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })

  if (!response.ok) {
    if (response.status === 429) throw new Error('Spotify is rate-limiting requests. Please retry in a moment.')
    throw new Error(`Spotify catalog lookup failed (${response.status}). Please reconnect and try again.`)
  }

  return response.json() as Promise<T>
}

async function findArtist(name: string, accessToken: string): Promise<SpotifyArtist | undefined> {
  const params = new URLSearchParams({ q: `artist:"${name.replaceAll('"', '')}"`, type: 'artist', limit: '5' })
  const result = await spotifyGet<ArtistSearchResponse>(`/search?${params}`, accessToken)
  return result.artists.items.find((artist) => normalizeName(artist.name) === normalizeName(name))
}

async function searchGenre(genre: string, accessToken: string): Promise<SpotifyArtist[]> {
  const params = new URLSearchParams({ q: `genre:"${genre.replaceAll('"', '')}"`, type: 'artist', limit: '20' })
  const result = await spotifyGet<ArtistSearchResponse>(`/search?${params}`, accessToken)
  return result.artists.items
}

async function inBatches<T, R>(items: T[], size: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const output: R[] = []
  for (let index = 0; index < items.length; index += size) {
    output.push(...await Promise.all(items.slice(index, index + size).map(task)))
  }
  return output
}

export async function discoverSpotifyVibe(
  accessToken: string,
  recap: YearRecap,
  allListenedArtists: string[],
): Promise<SpotifyDiscovery> {
  const listened = await inBatches(
    recap.artists.slice(0, 20),
    4,
    (artist: RankedArtist) => findArtist(artist.name, accessToken),
  )

  const genreScores = new Map<string, number>()
  for (let index = 0; index < listened.length; index += 1) {
    const artist = listened[index]
    if (!artist?.genres.length) continue
    const artistWeight = recap.artists[index].monthlyShare / artist.genres.length
    for (const genre of artist.genres) {
      genreScores.set(genre, (genreScores.get(genre) ?? 0) + artistWeight)
    }
  }

  const scoreTotal = [...genreScores.values()].reduce((total, score) => total + score, 0)
  const genres = [...genreScores.entries()]
    .map(([name, score]) => ({ name, share: scoreTotal ? (score / scoreTotal) * 100 : 0 }))
    .sort((a, b) => b.share - a.share)
    .slice(0, 5)

  if (!genres.length) return { genres, artists: [] }

  const listenedNames = new Set(allListenedArtists.map(normalizeName))
  const artistMatches = await inBatches(
    genres.slice(0, 4),
    2,
    async (genre) => ({ genre: genre.name, artists: await searchGenre(genre.name, accessToken) }),
  )

  const suggestions = new Map<string, SuggestedArtist & { matchedGenres: Set<string>; popularity: number }>()
  for (const { genre, artists } of artistMatches) {
    for (const artist of artists) {
      const key = normalizeName(artist.name)
      const spotifyUrl = artist.external_urls?.spotify
      if (!key || !spotifyUrl || listenedNames.has(key)) continue

      const matchedGenres = artist.genres.filter((candidate) =>
        genres.slice(0, 4).some((topGenre) => normalizeName(topGenre.name) === normalizeName(candidate)),
      )
      if (!matchedGenres.some((matched) => normalizeName(matched) === normalizeName(genre))) continue

      const existing = suggestions.get(key) ?? {
        name: artist.name,
        genres: matchedGenres,
        spotifyUrl,
        matchedGenres: new Set<string>(),
        popularity: artist.popularity ?? 0,
      }
      existing.matchedGenres.add(genre)
      suggestions.set(key, existing)
    }
  }

  const artists = [...suggestions.values()]
    .sort((a, b) => b.matchedGenres.size - a.matchedGenres.size || b.popularity - a.popularity)
    .slice(0, 5)
    .map(({ name, genres: artistGenres, spotifyUrl }) => ({ name, genres: artistGenres, spotifyUrl }))

  return { genres, artists }
}