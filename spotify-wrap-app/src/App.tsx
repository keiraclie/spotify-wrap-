import { useEffect, useRef, useState } from 'react'
import './App.css'
import {
  buildYearRecap,
  getHistoryYears,
  parseStreamingHistory,
  type HistoryRecord,
  type YearRecap,
} from './recap'
import {
  beginSpotifyAuthorization,
  discoverSpotifyVibe,
  exchangeSpotifyCode,
  getSpotifyRedirectUri,
  type SpotifyDiscovery,
} from './spotify'

function App() {
  const [records, setRecords] = useState<HistoryRecord[]>([])
  const [selectedYear, setSelectedYear] = useState<number | null>(null)
  const [recap, setRecap] = useState<YearRecap | null>(null)
  const [error, setError] = useState('')
  const [isDragging, setIsDragging] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [spotifyClientId, setSpotifyClientId] = useState('')
  const [spotifyToken, setSpotifyToken] = useState('')
  const [discovery, setDiscovery] = useState<SpotifyDiscovery | null>(null)
  const [catalogStatus, setCatalogStatus] = useState<'idle' | 'loading' | 'ready' | 'empty'>('idle')
  const [catalogError, setCatalogError] = useState('')
  const [isConnecting, setIsConnecting] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const authPopupRef = useRef<Window | null>(null)
  const popupMonitorRef = useRef<number | null>(null)
  const years = getHistoryYears(records)

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (!window.opener || (!params.has('code') && !params.has('error'))) return

    window.opener.postMessage({
      type: 'spotify-auth-callback',
      code: params.get('code'),
      state: params.get('state'),
      error: params.get('error'),
    }, window.location.origin)
    window.close()
  }, [])

  useEffect(() => {
    function handleAuthMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin || event.source !== authPopupRef.current) return
      if (event.data?.type !== 'spotify-auth-callback') return

      if (popupMonitorRef.current !== null) window.clearInterval(popupMonitorRef.current)
      popupMonitorRef.current = null
      authPopupRef.current = null

      if (event.data.error || !event.data.code || !event.data.state) {
        setIsConnecting(false)
        setCatalogError('Spotify sign-in was cancelled or denied.')
        return
      }

      void exchangeSpotifyCode(event.data.code, event.data.state)
        .then(setSpotifyToken)
        .catch((caughtError: unknown) => {
          setCatalogError(caughtError instanceof Error ? caughtError.message : 'Spotify sign-in failed.')
        })
        .finally(() => setIsConnecting(false))
    }

    window.addEventListener('message', handleAuthMessage)
    return () => {
      window.removeEventListener('message', handleAuthMessage)
      if (popupMonitorRef.current !== null) window.clearInterval(popupMonitorRef.current)
    }
  }, [])

  useEffect(() => {
    if (!spotifyToken || !recap) return

    let cancelled = false
    setCatalogStatus('loading')
    setCatalogError('')
    void discoverSpotifyVibe(
      spotifyToken,
      recap,
      [...new Set(records.map((record) => record.artistName))],
    )
      .then((result) => {
        if (cancelled) return
        setDiscovery(result)
        setCatalogStatus(result.genres.length ? 'ready' : 'empty')
      })
      .catch((caughtError: unknown) => {
        if (cancelled) return
        setCatalogError(caughtError instanceof Error ? caughtError.message : 'Spotify catalog lookup failed.')
        setCatalogStatus('idle')
      })

    return () => { cancelled = true }
  }, [spotifyToken, recap, records])

  async function loadFiles(files: FileList | null) {
    if (!files?.length) return

    setError('')
    setIsLoading(true)
    try {
      const contents = await Promise.all(
        Array.from(files).map((file) => file.text()),
      )
      const importedRecords = parseStreamingHistory(contents)
      const availableYears = getHistoryYears(importedRecords)
      if (!availableYears.length) {
        throw new Error('No qualifying plays were found in those files.')
      }

      setRecords(importedRecords)
      setSelectedYear(availableYears[0])
      setRecap(buildYearRecap(importedRecords, availableYears[0]))
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : 'Those files could not be read. Please choose Spotify JSON files.',
      )
    } finally {
      setIsLoading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  function changeYear(year: number) {
    setSelectedYear(year)
    setRecap(buildYearRecap(records, year))
  }

  function clearHistory() {
    setRecords([])
    setSelectedYear(null)
    setRecap(null)
    setDiscovery(null)
    setCatalogStatus('idle')
    setError('')
  }

  async function connectSpotify() {
    const clientId = spotifyClientId.trim()
    if (!clientId) return

    const popup = window.open('about:blank', 'side-a-spotify-auth', 'popup,width=520,height=720')
    if (!popup) {
      setCatalogError('Allow pop-ups for this page, then try connecting again.')
      return
    }

    authPopupRef.current = popup
    setIsConnecting(true)
    setCatalogError('')
    popupMonitorRef.current = window.setInterval(() => {
      if (popup.closed) {
        if (popupMonitorRef.current !== null) window.clearInterval(popupMonitorRef.current)
        popupMonitorRef.current = null
        authPopupRef.current = null
        setIsConnecting(false)
      }
    }, 500)

    try {
      await beginSpotifyAuthorization(clientId, popup)
    } catch (caughtError) {
      popup.close()
      setIsConnecting(false)
      setCatalogError(caughtError instanceof Error ? caughtError.message : 'Could not open Spotify sign-in.')
    }
  }

  function disconnectSpotify() {
    setSpotifyToken('')
    setDiscovery(null)
    setCatalogStatus('idle')
    setCatalogError('')
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="wordmark" href="#top" aria-label="Side A, home">
          <span className="wordmark-disc" aria-hidden="true">A</span>
          <span>SIDE A <span className="wordmark-year">/ YOUR YEAR IN SOUND</span></span>
        </a>
        {recap && (
          <button className="text-button" type="button" onClick={clearHistory}>
            Clear imported data
          </button>
        )}
      </header>

      <section className="intro" id="top">
        <div className="intro-copy">
          <p className="eyebrow"><span className="eyebrow-dot" /> A LISTENING RECAP, REBALANCED</p>
          <h1>Every month<br />gets a <em>moment.</em></h1>
          <p className="intro-description">
            Your year in music, with each listening month given equal weight.
            No single marathon month gets to tell the whole story.
          </p>
        </div>
        <aside className="method-stamp" aria-label="How the recap is weighted">
          <span className="stamp-number">12</span>
          <span className="stamp-caption">MONTHS<br />IN THE MIX</span>
          <span className="stamp-rule" />
          <span className="stamp-foot">ONE MONTH<br />ONE VOTE</span>
        </aside>
      </section>

      <section
        className={`upload-zone${isDragging ? ' is-dragging' : ''}`}
        onDragEnter={(event) => { event.preventDefault(); setIsDragging(true) }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setIsDragging(false)
          }
        }}
        onDrop={(event) => {
          event.preventDefault()
          setIsDragging(false)
          void loadFiles(event.dataTransfer.files)
        }}
        aria-label="Upload Spotify streaming history JSON files"
      >
        <input
          ref={fileInputRef}
          className="file-input"
          id="history-files"
          type="file"
          accept=".json,application/json"
          multiple
          onChange={(event) => void loadFiles(event.currentTarget.files)}
        />
        <div className="upload-symbol" aria-hidden="true">+</div>
        <div className="upload-copy">
          <p className="upload-title">Bring your listening history</p>
          <p className="upload-hint">Drop your Spotify JSON files here, or <label htmlFor="history-files">choose files</label></p>
          <p className="privacy-note">Need your files? <a href="https://www.spotify.com/account/privacy/" target="_blank" rel="noreferrer">Request Extended Streaming History</a>. Files stay in this browser.</p>
        </div>
        <div className="upload-meta">
          <span>SPOTIFY</span>
          <span>EXTENDED STREAMING HISTORY</span>
          <span>.JSON</span>
        </div>
      </section>

      {isLoading && <p className="status-message" role="status">Reading your listening history...</p>}
      {error && <p className="error-message" role="alert">{error}</p>}

      {recap && selectedYear !== null && (
        <RecapView
          recap={recap}
          years={years}
          onYearChange={changeYear}
          spotifyClientId={spotifyClientId}
          onClientIdChange={setSpotifyClientId}
          onConnect={connectSpotify}
          onDisconnect={disconnectSpotify}
          isConnected={Boolean(spotifyToken)}
          isConnecting={isConnecting}
          catalogStatus={catalogStatus}
          catalogError={catalogError}
          discovery={discovery}
        />
      )}

      <footer className="page-footer">
        <span>SIDE A / LISTENING NOTES</span>
        <span>Built from your own listening history</span>
      </footer>
    </main>
  )
}

function RecapView({
  recap,
  years,
  onYearChange,
  spotifyClientId,
  onClientIdChange,
  onConnect,
  onDisconnect,
  isConnected,
  isConnecting,
  catalogStatus,
  catalogError,
  discovery,
}: {
  recap: YearRecap
  years: number[]
  onYearChange: (year: number) => void
  spotifyClientId: string
  onClientIdChange: (clientId: string) => void
  onConnect: () => void
  onDisconnect: () => void
  isConnected: boolean
  isConnecting: boolean
  catalogStatus: 'idle' | 'loading' | 'ready' | 'empty'
  catalogError: string
  discovery: SpotifyDiscovery | null
}) {
  const topTrack = recap.tracks[0]
  const topArtist = recap.artists[0]

  return (
    <section className="recap" aria-live="polite">
      <div className="recap-heading">
        <div>
          <p className="eyebrow"><span className="eyebrow-dot coral" /> YOUR LISTENING, IN PERSPECTIVE</p>
          <h2>The year, <span>replayed.</span></h2>
        </div>
        <label className="year-picker">
          <span>RECAP YEAR</span>
          <select
            value={recap.year}
            onChange={(event) => onYearChange(Number(event.currentTarget.value))}
            aria-label="Choose recap year"
          >
            {years.map((year) => <option key={year} value={year}>{year}</option>)}
          </select>
        </label>
      </div>

      <div className="summary-strip">
        <div><strong>{recap.totalPlays.toLocaleString()}</strong><span>QUALIFYING PLAYS</span></div>
        <div><strong>{recap.activeMonths}<small> / 12</small></strong><span>ACTIVE MONTHS</span></div>
        <p>All 12 months count equally. Months with no qualifying plays contribute zero.</p>
      </div>

      <section className="monthly-section" aria-labelledby="monthly-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">THE YEAR AT A GLANCE</p>
            <h3 id="monthly-title">Your listening, month by month</h3>
          </div>
          <span className="chart-legend"><i /> 30+ second plays</span>
        </div>
        <div className="month-chart">
          {recap.months.map((month) => (
            <div className="month-column" key={month.number} title={`${month.label}: ${month.plays} qualifying plays`}>
              <span className="month-count">{month.plays ? month.plays.toLocaleString() : ''}</span>
              <div className="bar-track">
                <div
                  className={`month-bar${month.plays === recap.peakMonthPlays ? ' peak' : ''}`}
                  style={{ height: `${month.plays ? Math.max(8, (month.plays / (recap.peakMonthPlays || 1)) * 100) : 2}%` }}
                />
              </div>
              <span className="month-label">{month.label}</span>
            </div>
          ))}
        </div>
      </section>

      <div className="rankings-grid">
        <section className="ranking-section" aria-labelledby="song-title">
          <div className="section-heading compact-heading">
            <div>
              <p className="eyebrow">THE ONE ON REPEAT</p>
              <h3 id="song-title">Favorite song</h3>
            </div>
            <span className="ranking-number">01</span>
          </div>
          {topTrack ? (
            <div className="feature-pick song-pick">
              <span className="feature-kicker">YEARLY FAVORITE</span>
              <h4>{topTrack.name}</h4>
              <p>{topTrack.artist}</p>
              <div className="pick-metrics">
                <span>{topTrack.monthlyShare.toFixed(1)}% <small>AVG MONTHLY SHARE</small></span>
                <span>{topTrack.plays} <small>PLAYS</small></span>
              </div>
              {topTrack.spotifyUrl && (
                <a className="spotify-link" href={topTrack.spotifyUrl} target="_blank" rel="noreferrer">
                  Open in Spotify <span aria-hidden="true">↗</span>
                </a>
              )}
            </div>
          ) : <p className="empty-note">No qualifying song plays for this year.</p>}
        </section>

        <section className="ranking-section" aria-labelledby="artist-title">
          <div className="section-heading compact-heading">
            <div>
              <p className="eyebrow">THE ARTIST WHO STAYED</p>
              <h3 id="artist-title">Top artists</h3>
            </div>
            <span className="ranking-number coral-number">02</span>
          </div>
          {topArtist ? (
            <ol className="rank-list">
              {recap.artists.slice(0, 5).map((artist, index) => (
                <li key={artist.name}>
                  <span className="rank-index">0{index + 1}</span>
                  <span className="rank-name">{artist.name}</span>
                  <span className="rank-score">{artist.monthlyShare.toFixed(1)}%</span>
                </li>
              ))}
            </ol>
          ) : <p className="empty-note">No artist plays for this year.</p>}
          {topArtist && <p className="list-caption">Average share of qualifying plays per active month</p>}
        </section>
      </div>

      <section className="discovery-section" aria-labelledby="discovery-title">
        <div className="discovery-header">
          <div className="discovery-mark" aria-hidden="true">B</div>
          <div className="discovery-copy">
            <p className="eyebrow">SIDE B / WHAT'S NEXT</p>
            <h3 id="discovery-title">Genres & artists to explore</h3>
            <p>
              Spotify’s export has your plays, not genre labels. Connect Spotify to match your artists to genres
              and discover new names with a similar sound.
            </p>
          </div>
          <div className="discovery-status">
            <span className={`status-dot${isConnected ? ' connected' : ''}`} />
            {isConnected ? 'SPOTIFY CONNECTED' : 'OPTIONAL SPOTIFY CONNECTION'}
          </div>
        </div>

        <div className="connect-panel">
          <label className="client-id-field">
            <span>SPOTIFY CLIENT ID</span>
            <input
              type="text"
              value={spotifyClientId}
              onChange={(event) => onClientIdChange(event.currentTarget.value)}
              placeholder="Paste your Client ID"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <button className="connect-button" type="button" onClick={onConnect} disabled={!spotifyClientId.trim() || isConnecting}>
            {isConnecting ? 'Connecting...' : isConnected ? 'Refresh matches' : 'Connect Spotify'}
            <span aria-hidden="true">↗</span>
          </button>
          {isConnected && <button className="disconnect-button" type="button" onClick={onDisconnect}>Disconnect</button>}
        </div>

        <p className="redirect-note">
          In your Spotify app settings, register this Redirect URI: <code>{getSpotifyRedirectUri()}</code>
          {' '}Only the Client ID is used here. Do not enter a client secret.
          {' '}<a href="https://developer.spotify.com/dashboard" target="_blank" rel="noreferrer">Spotify Developer Dashboard</a>
        </p>

        {isConnecting && <p className="catalog-message" role="status">Complete sign-in in the Spotify pop-up.</p>}
        {catalogStatus === 'loading' && <p className="catalog-message" role="status">Matching your artists and finding the shared sounds...</p>}
        {catalogError && <p className="catalog-error" role="alert">{catalogError}</p>}
        {catalogStatus === 'empty' && (
          <p className="catalog-message">Spotify did not return genre labels for these artists. Try another export or account.</p>
        )}

        {catalogStatus === 'ready' && discovery && (
          <div className="discovery-results">
            <div className="genre-breakdown">
              <p className="eyebrow">YOUR GENRE MIX <span className="approx-label">ESTIMATED FROM MATCHED ARTISTS</span></p>
              {discovery.genres.map((genre, index) => (
                <div className="genre-row" key={genre.name}>
                  <span className="genre-index">0{index + 1}</span>
                  <span className="genre-name">{genre.name}</span>
                  <span className="genre-meter"><i style={{ width: `${genre.share}%` }} /></span>
                  <span className="genre-share">{genre.share.toFixed(0)}%</span>
                </div>
              ))}
            </div>
            <div className="suggestion-list">
              <p className="eyebrow">SAME VIBE, NEW NAMES</p>
              {discovery.artists.length ? (
                <ol>
                  {discovery.artists.map((artist, index) => (
                    <li key={artist.name}>
                      <span className="suggestion-index">0{index + 1}</span>
                      <span className="suggestion-name">{artist.name}<small>{artist.genres.slice(0, 2).join(' / ')}</small></span>
                      <a href={artist.spotifyUrl} target="_blank" rel="noreferrer" aria-label={`Open ${artist.name} in Spotify`}>↗</a>
                    </li>
                  ))}
                </ol>
              ) : <p className="no-suggestions">No new artists surfaced for the matched genres yet.</p>}
            </div>
          </div>
        )}
      </section>
      <p className="method-footnote">
        Method: plays under 30 seconds are excluded. For each artist and song, monthly play share is averaged
        across all 12 calendar months. Months with no qualifying plays contribute zero.
      </p>
    </section>
  )
}

export default App
