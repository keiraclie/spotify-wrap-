export interface HistoryRecord {
  timestamp: Date
  month: number
  year: number
  trackName: string
  artistName: string
  spotifyTrackUri?: string
}

export interface RankedTrack {
  name: string
  artist: string
  plays: number
  monthlyShare: number
  spotifyUrl?: string
}

export interface RankedArtist {
  name: string
  plays: number
  monthlyShare: number
}

export interface RecapMonth {
  number: number
  label: string
  plays: number
}

export interface YearRecap {
  year: number
  totalPlays: number
  activeMonths: number
  peakMonthPlays: number
  months: RecapMonth[]
  tracks: RankedTrack[]
  artists: RankedArtist[]
}

const MINIMUM_LISTEN_MS = 30_000

export function parseStreamingHistory(contents: string[]): HistoryRecord[] {
  const records: HistoryRecord[] = []

  for (const content of contents) {
    let rows: unknown
    try {
      rows = JSON.parse(content)
    } catch {
      throw new Error('One of those files is not valid JSON.')
    }

    if (!Array.isArray(rows)) {
      throw new Error('Spotify history files should contain a JSON array.')
    }

    for (const row of rows) {
      if (!row || typeof row !== 'object') continue

      const entry = row as Record<string, unknown>
      const hasExtendedTimestamp = typeof entry.ts === 'string'
      const timestamp = new Date(String(entry.ts ?? entry.endTime ?? ''))
      const rawTrackName = entry.master_metadata_track_name ?? entry.track_name ?? entry.trackName
      const rawArtistName = entry.master_metadata_album_artist_name ?? entry.artist_name ?? entry.artistName
      const rawPlayedMs = entry.ms_played ?? entry.msPlayed
      const trackName = typeof rawTrackName === 'string' ? rawTrackName.trim() : ''
      const artistName = typeof rawArtistName === 'string' ? rawArtistName.trim() : ''
      const playedMs = Number(rawPlayedMs)

      if (
        !Number.isFinite(timestamp.getTime()) ||
        !trackName ||
        !artistName ||
        !Number.isFinite(playedMs) ||
        playedMs < MINIMUM_LISTEN_MS
      ) {
        continue
      }

      records.push({
        timestamp,
        month: hasExtendedTimestamp ? timestamp.getUTCMonth() : timestamp.getMonth(),
        year: hasExtendedTimestamp ? timestamp.getUTCFullYear() : timestamp.getFullYear(),
        trackName,
        artistName,
        spotifyTrackUri:
          typeof (entry.spotify_track_uri ?? entry.master_metadata_track_uri) === 'string'
            ? String(entry.spotify_track_uri ?? entry.master_metadata_track_uri)
            : undefined,
      })
    }
  }

  return records
}

export function getHistoryYears(records: HistoryRecord[]): number[] {
  return [...new Set(records.map((record) => record.year))].sort((a, b) => b - a)
}

export function buildYearRecap(records: HistoryRecord[], year: number): YearRecap {
  const yearRecords = records.filter((record) => record.year === year)
  const monthTotals = new Map<number, number>()
  const trackStats = new Map<string, {
    name: string
    artist: string
    plays: number
    monthlyPlays: Map<number, number>
    spotifyTrackUri?: string
  }>()
  const artistStats = new Map<string, {
    name: string
    plays: number
    monthlyPlays: Map<number, number>
  }>()

  for (const record of yearRecords) {
    monthTotals.set(record.month, (monthTotals.get(record.month) ?? 0) + 1)

    const trackKey = `${record.trackName.toLocaleLowerCase()}\u0000${record.artistName.toLocaleLowerCase()}`
    const track = trackStats.get(trackKey) ?? {
      name: record.trackName,
      artist: record.artistName,
      plays: 0,
      monthlyPlays: new Map<number, number>(),
      spotifyTrackUri: record.spotifyTrackUri,
    }
    track.plays += 1
    track.monthlyPlays.set(record.month, (track.monthlyPlays.get(record.month) ?? 0) + 1)
    track.spotifyTrackUri ??= record.spotifyTrackUri
    trackStats.set(trackKey, track)

    const artistKey = record.artistName.toLocaleLowerCase()
    const artist = artistStats.get(artistKey) ?? {
      name: record.artistName,
      plays: 0,
      monthlyPlays: new Map<number, number>(),
    }
    artist.plays += 1
    artist.monthlyPlays.set(record.month, (artist.monthlyPlays.get(record.month) ?? 0) + 1)
    artistStats.set(artistKey, artist)
  }

  const activeMonthCount = monthTotals.size
  const monthlyShare = (monthlyPlays: Map<number, number>) => {
    if (!yearRecords.length) return 0
    let shareTotal = 0
    for (let month = 0; month < 12; month += 1) {
      const total = monthTotals.get(month) ?? 0
      if (!total) continue
      shareTotal += (monthlyPlays.get(month) ?? 0) / total
    }
    return (shareTotal / 12) * 100
  }

  const months = Array.from({ length: 12 }, (_, month) => ({
    number: month,
    label: new Intl.DateTimeFormat('en', { month: 'short' }).format(new Date(year, month, 1)),
    plays: monthTotals.get(month) ?? 0,
  }))

  return {
    year,
    totalPlays: yearRecords.length,
    activeMonths: activeMonthCount,
    peakMonthPlays: Math.max(0, ...months.map((month) => month.plays)),
    months,
    tracks: [...trackStats.values()]
      .map((track) => ({
        name: track.name,
        artist: track.artist,
        plays: track.plays,
        monthlyShare: monthlyShare(track.monthlyPlays),
        spotifyUrl: track.spotifyTrackUri?.startsWith('spotify:track:')
          ? `https://open.spotify.com/track/${track.spotifyTrackUri.slice('spotify:track:'.length)}`
          : undefined,
      }))
      .sort((a, b) => b.monthlyShare - a.monthlyShare || b.plays - a.plays),
    artists: [...artistStats.values()]
      .map((artist) => ({
        name: artist.name,
        plays: artist.plays,
        monthlyShare: monthlyShare(artist.monthlyPlays),
      }))
      .sort((a, b) => b.monthlyShare - a.monthlyShare || b.plays - a.plays),
  }
}