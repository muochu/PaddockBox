const CACHE_TTL_MS = 10 * 60 * 1000 // 10 minutes
const DRIVERS_LIST_CACHE_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours
const RATE_LIMIT_DELAY_MS = 150 // Minimal delay between requests
const MAX_RETRIES = 1 // Fast fail on errors
// Try mirror first, fallback to original Ergast API
const ERGAST_MIRROR = 'https://api.jolpi.ca/ergast/f1'
const ERGAST_ORIGINAL = 'http://ergast.com/api/f1'
const ERGAST_BASE_URL = ERGAST_MIRROR
const cache = new Map()
let driversListCache = null
let driversListExpiresAt = 0
let lastRequestTime = 0

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'fetch-driver') {
    handleDriverRequest(message.slug)
      .then((data) => {
        console.log(
          'F1 Hover Stats background: Successfully fetched data for',
          message.slug
        )
        sendResponse({ data })
      })
      .catch((error) => {
        console.error(
          'F1 Hover Stats background: Error fetching driver data:',
          error
        )
        const errorMessage =
          error?.message || error?.toString() || 'Unknown error'
        sendResponse({ error: errorMessage })
      })
    return true // Indicates we will send a response asynchronously
  }

  if (message?.type === 'fetch-drivers-list') {
    handleDriversListRequest()
      .then((data) => sendResponse({ data }))
      .catch((error) => {
        console.error('F1 Hover Stats background:', error)
        sendResponse({ error: error.message || 'Unknown error' })
      })
    return true
  }
})

async function handleDriverRequest(slug, loadAllSeasons = false) {
  if (!slug) {
    throw new Error('Missing driver slug')
  }

  const cached = cache.get(slug)
  const now = Date.now()
  // If we have cached data and it has all seasons, return it
  if (cached && cached.expiresAt > now && (!loadAllSeasons || cached.data.allSeasonsLoaded)) {
    return cached.data
  }

  console.log(`F1 Hover Stats background: Fetching data for driver: ${slug}`)

  let driverInfoRes, seasonsRes
  try {
    ;[driverInfoRes, seasonsRes] = await Promise.all([
      fetchJson(`${ERGAST_BASE_URL}/drivers/${slug}/`),
      fetchJson(`${ERGAST_BASE_URL}/drivers/${slug}/seasons/`),
    ])
  } catch (error) {
    console.error(
      `F1 Hover Stats background: Failed to fetch driver info or seasons for ${slug}:`,
      error
    )
    throw new Error(
      `Failed to fetch driver data: ${error.message || 'Network error'}`
    )
  }

  const driver = driverInfoRes?.MRData?.DriverTable?.Drivers?.[0]
  if (!driver) {
    throw new Error(
      `Driver not found: ${slug}. Check if the driver ID is correct.`
    )
  }

  const allSeasonsList =
    seasonsRes?.MRData?.SeasonTable?.Seasons?.map((season) => season.season) ??
    []

  if (allSeasonsList.length === 0) {
    console.warn(
      `F1 Hover Stats background: No seasons found for ${slug}, using driver info only`
    )
    // Return minimal data if no seasons found
    return {
      driver,
      seasons: [],
      currentSeason: null,
      seasonSummaries: [],
      seasonResults: [],
      seasonResultsSummary: null,
    }
  }

  // Filter out future seasons and only fetch seasons that likely have data
  const currentYear = new Date().getFullYear()
  const validSeasons = allSeasonsList.filter(
    (season) => Number(season) <= currentYear && Number(season) >= 1950
  )

  // If loadAllSeasons is true, fetch all seasons. Otherwise, just fetch 5 for fast loading
  const seasonsToFetch = loadAllSeasons 
    ? validSeasons.slice(-8) // Load up to 8 seasons when "Show more" is clicked
    : validSeasons.slice(-5) // Initial load: only 5 seasons for speed
  
  const remainingSeasons = loadAllSeasons ? [] : validSeasons.slice(0, -5)

  // Fetch seasons
  const seasonsData = await fetchSeasonStandings(slug, seasonsToFetch)
  
  // If not loading all, fetch remaining in background
  if (!loadAllSeasons && remainingSeasons.length > 0) {
    fetchSeasonStandings(slug, remainingSeasons).then((remainingData) => {
      const allSeasonsData = [...seasonsData, ...remainingData]
      const seasonsMap = new Map()
      allSeasonsData.forEach((s) => seasonsMap.set(s.season, s))
      const completeSeasons = validSeasons
        .map((season) => seasonsMap.get(season))
        .filter(Boolean)
        .sort((a, b) => Number(a.season) - Number(b.season))
      
      // Update cache with complete data
      const cached = cache.get(slug)
      if (cached) {
        cached.data.seasons = completeSeasons
        cached.data.allSeasonsLoaded = true
      }
    }).catch((err) => {
      console.warn('Background season fetch failed:', err)
    })
  }

  // Only include seasons with actual data (no placeholders)
  const seasonsMap = new Map()
  seasonsData.forEach((s) => seasonsMap.set(s.season, s))

  // Only return seasons that have actual standings data
  const completeSeasons = seasonsToFetch
    .map((season) => seasonsMap.get(season))
    .filter(Boolean) // Remove any null/undefined entries

  const orderedSeasons = completeSeasons.sort(
    (a, b) => Number(a.season) - Number(b.season)
  )
  const latestSeasonEntry = orderedSeasons.filter((s) => !s._incomplete).at(-1)
  const currentSeason = latestSeasonEntry?.season

  const recentSeasonIds = orderedSeasons.slice(-3).map((s) => s.season)

  const [currentSeasonSnapshot, currentSeasonResults, seasonSummaries] =
    await Promise.all([
      currentSeason ? fetchCurrentSeasonSnapshot(slug, currentSeason) : null,
      currentSeason ? fetchSeasonResultsData(slug, currentSeason) : null,
      fetchSeasonSummaries(slug, recentSeasonIds),
    ])

  const data = {
    driver,
    seasons: orderedSeasons,
    currentSeason: currentSeasonSnapshot,
    seasonSummaries,
    seasonResults: currentSeasonResults?.races ?? [],
    seasonResultsSummary: currentSeasonResults?.summary ?? null,
  }
  cache.set(slug, { data, expiresAt: now + CACHE_TTL_MS })
  return data
}

async function fetchSeasonStandings(slug, seasons) {
  if (!Array.isArray(seasons) || seasons.length === 0) {
    return []
  }

  const results = []

  const fetchWithRetry = async (season, retries = 1) => {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        // Fetch driver standings first (required)
        const driverRes = await fetchJson(
          `${ERGAST_BASE_URL}/${season}/drivers/${slug}/driverstandings/`
        )

        const standing =
          driverRes?.MRData?.StandingsTable?.StandingsLists?.[0]
            ?.DriverStandings?.[0]
        if (!standing || !standing.position || standing.position === '?') {
          return null
        }

        const constructors = (standing.Constructors || []).map(
          (team) => team.name
        )

        // Only fetch constructor standings for recent seasons (last 5) to save time
        const currentYear = new Date().getFullYear()
        let isConstructorChampion = false
        if (Number(season) >= currentYear - 5) {
          try {
            const constructorRes = await fetchJson(
              `${ERGAST_BASE_URL}/${season}/constructorstandings/`
            )
            const championConstructor =
              constructorRes?.MRData?.StandingsTable?.StandingsLists?.[0]
                ?.ConstructorStandings?.[0]?.Constructor?.name
            isConstructorChampion = constructors.includes(championConstructor)
          } catch (err) {
            // Ignore constructor fetch errors for older seasons
            console.warn(`Skipping constructor data for ${season}`)
          }
        }

        return {
          season,
          position: standing.position,
          points: standing.points,
          wins: Number(standing.wins) || 0,
          constructors,
          isChampion: Number(standing.position) === 1,
          isConstructorChampion,
        }
      } catch (error) {
        if (attempt === retries) {
          console.warn(
            `F1 Hover Stats background: Failed to fetch standings for ${season}/${slug} after ${
              retries + 1
            } attempts:`,
            error.message
          )
          return null
        }
        // Wait before retry
        await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)))
      }
    }
    return null
  }

  // Process in smaller parallel batches to balance speed and rate limits
  const batchSize = 3
  for (let i = 0; i < seasons.length; i += batchSize) {
    const batch = seasons.slice(i, i + batchSize)
    // Process batch in parallel for speed
    const batchPromises = batch.map((season) => fetchWithRetry(season))
    const batchResults = await Promise.all(batchPromises)
    results.push(...batchResults.filter(Boolean))

    // Small delay between batches to avoid rate limits
    if (i + batchSize < seasons.length) {
      await new Promise((resolve) =>
        setTimeout(resolve, RATE_LIMIT_DELAY_MS * 2)
      )
    }
  }

  return results
}

async function fetchCurrentSeasonSnapshot(slug, season) {
  try {
    const standingsRes = await fetchJson(
      `${ERGAST_BASE_URL}/${season}/drivers/${slug}/driverstandings/`
    )
    const standing =
      standingsRes?.MRData?.StandingsTable?.StandingsLists?.[0]
        ?.DriverStandings?.[0]
    if (!standing) {
      return null
    }
    return {
      season,
      position: standing.position,
      points: standing.points,
      wins: Number(standing.wins) || 0,
      constructors: (standing.Constructors || []).map((team) => team.name),
    }
  } catch (error) {
    console.warn(
      `F1 Hover Stats background: Failed to fetch current season snapshot for ${season}/${slug}`,
      error
    )
    return null
  }
}

async function fetchSeasonResultsData(slug, season) {
  // Try multiple endpoints for better reliability
  const currentYear = new Date().getFullYear()
  const urls = []

  if (Number(season) === currentYear) {
    // For current season, try current endpoint first
    urls.push(
      `${ERGAST_BASE_URL}/current/drivers/${slug}/results.json?limit=500`
    )
  }
  // Always try the specific season endpoint
  urls.push(
    `${ERGAST_BASE_URL}/${season}/drivers/${slug}/results.json?limit=500`
  )

  for (const url of urls) {
    try {
      const res = await fetchJson(url) // Try with fallback
      const races = res?.MRData?.RaceTable?.Races ?? []

      if (races.length > 0) {
        const parsed = races
          .map((race) => {
            const result = race.Results?.[0]
            if (!result) {
              return null
            }
            return {
              raceName: race.raceName,
              circuit: race.Circuit?.circuitName,
              date: race.date,
              position: result.position,
              positionText: result.positionText,
              points: Number(result.points) || 0,
              status: result.status,
              grid: result.grid,
              laps: result.laps,
            }
          })
          .filter(Boolean)

        const summary = summarizeSeason(parsed)

        return {
          races: parsed,
          summary,
        }
      }
    } catch (error) {
      console.warn(
        `F1 Hover Stats background: Failed to fetch from ${url}:`,
        error.message
      )
      // Continue to next URL
    }
  }

  // If all URLs failed, return empty
  console.warn(
    `F1 Hover Stats background: All attempts failed for season results ${season}/${slug}`
  )
  return { races: [], summary: null }
}

async function fetchSeasonSummaries(slug, seasons) {
  if (!Array.isArray(seasons) || seasons.length === 0) {
    return []
  }

  const requests = seasons.map((season) =>
    fetchSeasonResultsData(slug, season).then((data) =>
      data.summary
        ? {
            season,
            ...data.summary,
          }
        : null
    )
  )

  const results = await Promise.all(requests)
  return results.filter(Boolean)
}

function summarizeSeason(races) {
  if (!races.length) {
    return null
  }

  const wins = races.filter((race) => Number(race.position) === 1).length
  const podiums = races.filter((race) => Number(race.position) <= 3).length
  const points = races.reduce((sum, race) => sum + (race.points || 0), 0)
  const avgFinish =
    races.reduce((sum, race) => sum + Number(race.position), 0) / races.length

  return {
    races: races.length,
    wins,
    podiums,
    points,
    avgFinish: Number(avgFinish.toFixed(1)),
  }
}

async function handleDriversListRequest() {
  const now = Date.now()
  if (driversListCache && driversListExpiresAt > now) {
    console.log(
      'F1 Hover Stats background: Returning cached drivers list',
      driversListCache.length
    )
    return driversListCache
  }

  console.log('F1 Hover Stats background: Fetching drivers list...')

  try {
    // Try current season first
    console.log('F1 Hover Stats background: Trying current season endpoint...')
    const currentData = await fetchJson(
      `${ERGAST_BASE_URL}/current/drivers.json`
    )
    console.log(
      'F1 Hover Stats background: Current season response:',
      currentData
    )
    const drivers = currentData?.MRData?.DriverTable?.Drivers ?? []

    if (drivers.length > 0) {
      const list = drivers.map((driver) => ({
        name: `${driver.givenName} ${driver.familyName}`,
        slug: driver.driverId,
        code: driver.code || null,
      }))

      console.log(
        'F1 Hover Stats background: Loaded',
        list.length,
        'drivers from current season'
      )
      driversListCache = list
      driversListExpiresAt = now + DRIVERS_LIST_CACHE_TTL_MS
      return list
    } else {
      console.warn(
        'F1 Hover Stats background: Current season returned 0 drivers'
      )
    }
  } catch (error) {
    console.error(
      'F1 Hover Stats background: Failed to fetch current drivers:',
      error
    )
  }

  // Fallback: fetch all drivers (last 3 seasons worth)
  console.log('F1 Hover Stats background: Trying fallback - last 3 seasons...')
  const currentYear = new Date().getFullYear()
  const allDrivers = new Map()

  for (let year = currentYear; year >= currentYear - 2; year--) {
    try {
      console.log(`F1 Hover Stats background: Fetching drivers for ${year}...`)
      const yearData = await fetchJson(
        `${ERGAST_BASE_URL}/${year}/drivers.json`
      )
      const yearDrivers = yearData?.MRData?.DriverTable?.Drivers ?? []
      console.log(
        `F1 Hover Stats background: Found ${yearDrivers.length} drivers for ${year}`
      )
      yearDrivers.forEach((driver) => {
        if (!allDrivers.has(driver.driverId)) {
          allDrivers.set(driver.driverId, {
            name: `${driver.givenName} ${driver.familyName}`,
            slug: driver.driverId,
            code: driver.code || null,
          })
        }
      })
    } catch (error) {
      console.error(
        `F1 Hover Stats background: Failed to fetch drivers for ${year}:`,
        error
      )
    }
  }

  const list = Array.from(allDrivers.values())
  console.log(
    'F1 Hover Stats background: Total unique drivers found:',
    list.length
  )

  // If still no drivers, use hardcoded fallback
  if (list.length === 0) {
    console.warn(
      'F1 Hover Stats background: No drivers from API, using hardcoded fallback'
    )
    return [
      { name: 'Max Verstappen', slug: 'verstappen', code: 'VER' },
      { name: 'Sergio Pérez', slug: 'perez', code: 'PER' },
      { name: 'Lewis Hamilton', slug: 'hamilton', code: 'HAM' },
      { name: 'George Russell', slug: 'russell', code: 'RUS' },
      { name: 'Charles Leclerc', slug: 'leclerc', code: 'LEC' },
      { name: 'Carlos Sainz', slug: 'sainz', code: 'SAI' },
      { name: 'Lando Norris', slug: 'norris', code: 'NOR' },
      { name: 'Oscar Piastri', slug: 'piastri', code: 'PIA' },
      { name: 'Fernando Alonso', slug: 'alonso', code: 'ALO' },
      { name: 'Lance Stroll', slug: 'stroll', code: 'STR' },
      { name: 'Esteban Ocon', slug: 'ocon', code: 'OCO' },
      { name: 'Pierre Gasly', slug: 'gasly', code: 'GAS' },
      { name: 'Alexander Albon', slug: 'albon', code: 'ALB' },
      { name: 'Logan Sargeant', slug: 'sargeant', code: 'SAR' },
      { name: 'Yuki Tsunoda', slug: 'tsunoda', code: 'TSU' },
      { name: 'Daniel Ricciardo', slug: 'ricciardo', code: 'RIC' },
      { name: 'Valtteri Bottas', slug: 'bottas', code: 'BOT' },
      { name: 'Guanyu Zhou', slug: 'zhou', code: 'ZHO' },
      { name: 'Kevin Magnussen', slug: 'magnussen', code: 'MAG' },
      { name: 'Nico Hülkenberg', slug: 'hulkenberg', code: 'HUL' },
    ]
  }

  driversListCache = list
  driversListExpiresAt = now + DRIVERS_LIST_CACHE_TTL_MS
  return list
}

async function fetchJson(url, retryWithOriginal = true, retryCount = 0) {
  console.log('F1 Hover Stats background: Fetching', url)

  // Enforce minimum time between requests to avoid rate limiting
  const timeSinceLastRequest = Date.now() - lastRequestTime
  if (timeSinceLastRequest < RATE_LIMIT_DELAY_MS) {
    const waitTime = RATE_LIMIT_DELAY_MS - timeSinceLastRequest
    await new Promise((resolve) => setTimeout(resolve, waitTime))
  }
  lastRequestTime = Date.now()

  try {
    const response = await fetch(url, { cache: 'no-store' })
    console.log(
      'F1 Hover Stats background: Response status',
      response.status,
      'for',
      url
    )

    // Handle rate limiting with exponential backoff
    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After')
      const waitTime = retryAfter
        ? Number(retryAfter) * 1000
        : Math.min(1000 * Math.pow(2, retryCount), 10000) // Exponential backoff, max 10s

      if (retryCount < MAX_RETRIES) {
        console.warn(
          `F1 Hover Stats background: Rate limited (429), waiting ${waitTime}ms before retry ${
            retryCount + 1
          }/${MAX_RETRIES}`
        )
        await new Promise((resolve) => setTimeout(resolve, waitTime))
        return fetchJson(url, retryWithOriginal, retryCount + 1)
      } else {
        throw new Error(
          `Rate limited (429): Too many requests. Please wait a moment and try again.`
        )
      }
    }

    if (!response.ok) {
      throw new Error(
        `Request failed: ${response.status} ${response.statusText}`
      )
    }
    const data = await response.json()
    console.log('F1 Hover Stats background: Successfully fetched', url)
    return data
  } catch (error) {
    // Don't retry with fallback if we're already retrying due to rate limit
    if (error.message?.includes('Rate limited')) {
      throw error
    }

    console.error('F1 Hover Stats background: Fetch error for', url, ':', error)

    // If using mirror and it fails, try original Ergast API as fallback
    if (retryWithOriginal && url.includes(ERGAST_MIRROR) && retryCount === 0) {
      const fallbackUrl = url.replace(ERGAST_MIRROR, ERGAST_ORIGINAL)
      console.log('F1 Hover Stats background: Trying fallback URL', fallbackUrl)
      try {
        await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_DELAY_MS))
        const response = await fetch(fallbackUrl, { cache: 'no-store' })
        if (response.ok) {
          const data = await response.json()
          console.log('F1 Hover Stats background: Fallback successful')
          return data
        }
      } catch (fallbackError) {
        console.error(
          'F1 Hover Stats background: Fallback also failed:',
          fallbackError
        )
      }
    }

    throw error
  }
}
