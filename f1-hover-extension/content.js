console.log('F1 Hover Stats: Content script loaded')

let DRIVER_DIRECTORY = []
let DRIVER_LOOKUP = {}
let driversListReady = false

// Debug helper - expose to window for testing
if (typeof window !== 'undefined') {
  window.__F1HoverStats = {
    getDrivers: () => DRIVER_DIRECTORY,
    getReady: () => driversListReady,
    testMatch: (text) => findDriverInText(text),
    rescan: () => scanForDrivers(document.body),
  }
}

const IGNORED_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'TEXTAREA',
  'INPUT',
  'CODE',
  'PRE',
  'OPTION',
])

const POPUP_CLASS = 'f1-popup'
const DRIVER_CLASS = 'f1-driver'
const driverDataCache = new Map()
let activeSlug = null
let pointerTracking = false
let popupHovered = false
let hideTimeout = null

const popup = document.createElement('div')
popup.className = POPUP_CLASS
popup.setAttribute('role', 'status')
popup.style.display = 'none'
document.documentElement.appendChild(popup)

popup.addEventListener('pointerenter', (event) => {
  event.stopPropagation()
  popupHovered = true
  pointerTracking = false
  clearTimeout(hideTimeout)
})

popup.addEventListener('pointerleave', (event) => {
  event.stopPropagation()
  popupHovered = false
  // Check if cursor moved to a driver name
  const nextTarget =
    event.relatedTarget ||
    document.elementFromPoint(event.clientX, event.clientY)
  if (nextTarget?.closest?.(`.${DRIVER_CLASS}`)) {
    return
  }
  // Hide after 1 second if cursor is still outside
  hideTimeout = setTimeout(() => {
    if (!popupHovered) {
      hidePopup()
    }
  }, 1000)
})

function updateDriverLookup() {
  DRIVER_LOOKUP = DRIVER_DIRECTORY.reduce((acc, driver) => {
    acc[driver.name.toLowerCase()] = driver
    return acc
  }, {})
}

function isWordBoundary(char) {
  if (!char) return true // End of string
  // Check if it's whitespace, punctuation, or non-alphanumeric
  return /[\s\W]/.test(char) || !/[a-zA-Z0-9]/.test(char)
}

function findDriverInText(text, startIndex = 0) {
  if (!text || DRIVER_DIRECTORY.length === 0) {
    return null
  }

  const lowerText = text.toLowerCase()
  const matches = []

  // Find all valid matches
  for (const driver of DRIVER_DIRECTORY) {
    const searchName = driver.name.toLowerCase()
    let index = lowerText.indexOf(searchName, startIndex)

    while (index !== -1) {
      const before = index > 0 ? text[index - 1] : null
      const afterIndex = index + searchName.length
      const after = afterIndex < text.length ? text[afterIndex] : null

      // Check word boundaries - allow start/end of text
      const beforeOk = before === null || isWordBoundary(before)
      const afterOk = after === null || isWordBoundary(after)

      if (beforeOk && afterOk) {
        matches.push({
          driver,
          index,
          length: driver.name.length,
          matchedText: text.slice(index, index + driver.name.length),
        })
      }

      index = lowerText.indexOf(searchName, index + 1)
    }
  }

  if (matches.length === 0) return null

  // Sort by index, then by length (prefer longer matches for same position)
  matches.sort((a, b) => {
    if (a.index !== b.index) return a.index - b.index
    return b.length - a.length
  })

  return matches[0]
}

function hasDriverName(text) {
  if (!text || DRIVER_DIRECTORY.length === 0) return false
  return findDriverInText(text) !== null
}

function scanForDrivers(root) {
  if (!root || root === popup) return

  const nodeType = root.nodeType
  if (nodeType === Node.TEXT_NODE) {
    if (driversListReady && DRIVER_DIRECTORY.length > 0) {
      injectDriverSpans(root)
    }
    return
  }

  if (nodeType !== Node.ELEMENT_NODE) {
    return
  }

  if (
    IGNORED_TAGS.has(root.tagName) ||
    root.classList.contains(DRIVER_CLASS) ||
    root.classList.contains(POPUP_CLASS)
  ) {
    return
  }

  root.childNodes.forEach((child) => scanForDrivers(child))
}

function injectDriverSpans(textNode) {
  const content = textNode.textContent
  if (!content || !hasDriverName(content)) {
    return
  }

  const fragment = document.createDocumentFragment()
  let lastIndex = 0
  let match
  let iterations = 0
  const maxIterations = 100 // Safety limit

  while (
    (match = findDriverInText(content, lastIndex)) !== null &&
    iterations < maxIterations
  ) {
    iterations++
    const preceding = content.slice(lastIndex, match.index)
    if (preceding) {
      fragment.appendChild(document.createTextNode(preceding))
    }

    fragment.appendChild(createDriverSpan(match.driver))
    const newIndex = match.index + match.length

    // Avoid infinite loops - if we didn't advance, break
    if (newIndex <= lastIndex) {
      fragment.appendChild(document.createTextNode(content.slice(lastIndex)))
      break
    }

    lastIndex = newIndex
  }

  const trailing = content.slice(lastIndex)
  if (trailing) {
    fragment.appendChild(document.createTextNode(trailing))
  }

  textNode.replaceWith(fragment)
}

function createDriverSpan(driver) {
  const span = document.createElement('span')
  span.className = DRIVER_CLASS
  span.dataset.driver = driver.slug
  span.textContent = driver.name
  span.tabIndex = 0
  span.setAttribute('role', 'button')
  span.setAttribute('aria-label', `${driver.name} stats`)
  return span
}

function positionPopup() {
  // Center the popup on screen dynamically
  const viewportWidth = window.innerWidth
  const viewportHeight = window.innerHeight
  const popupWidth = popup.offsetWidth || Math.min(1400, viewportWidth * 0.95)
  const popupHeight = popup.offsetHeight || Math.min(600, viewportHeight * 0.85)

  // Center horizontally and vertically
  const left = (viewportWidth - popupWidth) / 2
  const top = Math.max(20, (viewportHeight - popupHeight) / 2)

  popup.style.left = `${left}px`
  popup.style.top = `${top}px`
  popup.style.transform = 'translate(0, 0)'
}

function showPopup(content, x, y) {
  popup.innerHTML = content
  popup.style.display = 'block'
  popup.style.opacity = '1'

  // Use requestAnimationFrame to ensure DOM is updated before positioning
  requestAnimationFrame(() => {
    positionPopup()
  })
}

function hidePopup() {
  clearTimeout(hideTimeout)
  activeSlug = null
  pointerTracking = false
  popupHovered = false
  popup.style.display = 'none'
  popup.innerHTML = ''
}

async function handleDriverFocus(target, x, y) {
  const slug = target.dataset.driver
  if (!slug) {
    hidePopup()
    return
  }

  activeSlug = slug
  pointerTracking = true
  showPopup('Loading…', x, y)

  try {
    const data = await fetchDriverData(slug)
    if (activeSlug !== slug) {
      return
    }
    const html = buildPopupHtml(data)
    showPopup(html, x, y)
  } catch (error) {
    console.error('F1 Hover Stats:', error)
    if (activeSlug === slug) {
      showPopup('<strong>Unable to load driver data.</strong>', x, y)
    }
  }
}

async function fetchDriverData(slug) {
  if (driverDataCache.has(slug)) {
    return driverDataCache.get(slug)
  }

  const request = requestDriverDataFromBackground(slug)
  driverDataCache.set(slug, request)
  return request
}

function requestDriverDataFromBackground(slug) {
  return new Promise((resolve, reject) => {
    if (!chrome?.runtime?.sendMessage) {
      reject(new Error('Extension messaging unavailable'))
      return
    }

    chrome.runtime.sendMessage({ type: 'fetch-driver', slug }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message))
        return
      }

      if (!response) {
        reject(new Error('Empty response from background worker'))
        return
      }

      if (response.error) {
        reject(new Error(response.error))
        return
      }

      resolve(response.data)
    })
  })
}

function buildPopupHtml(data) {
  const {
    driver,
    seasons,
    currentSeason,
    seasonSummaries = [],
    seasonResults = [],
    seasonResultsSummary,
  } = data
  if (!driver) {
    return '<strong>No driver data available.</strong>'
  }

  const formattedDOB = formatDate(driver.dateOfBirth)

  // Filter out incomplete seasons for calculations
  const completeSeasons = seasons.filter((s) => !s._incomplete)
  const totalWins = completeSeasons.reduce(
    (sum, season) => sum + (season.wins || 0),
    0
  )
  const championships = completeSeasons.filter(
    (season) => Number(season.position) === 1
  ).length

  // Use all seasons (including incomplete) for count, but complete ones for display
  const totalSeasonsCount = seasons.length
  const lastSeason = completeSeasons.at(-1)?.season || seasons.at(-1)?.season
  const firstSeason = seasons[0]?.season
  const seasonsToDisplay = [...seasons].reverse()

  const seasonRows = seasonsToDisplay
    .map((season) => {
      const constructorLabel = season.constructors.join(', ')
      const driverBadge = season.isChampion
        ? '<span class="season-icon" title="Driver Champion">🏆</span>'
        : ''
      const constructorBadge = season.isConstructorChampion
        ? '<span class="season-icon constructor" title="Constructor Champion">🏎</span>'
        : ''
      return `
        <div class="season-row">
          <span class="season-year">
            ${season.season}
            ${driverBadge}
            ${constructorBadge}
          </span>
          <span class="season-team">${constructorLabel || '-'}</span>
          <span class="season-metric">P${season.position}</span>
          <span class="season-metric">${season.points} pts</span>
          <span class="season-metric">${season.wins} wins</span>
        </div>
      `
    })
    .join('')

  const timelineSeasons = [...seasons].sort(
    (a, b) => Number(a.season) - Number(b.season)
  )
  const seasonTimelineHtml = timelineSeasons
    .map((season) => {
      const driverBadge = season.isChampion
        ? '<span class="season-badge trophy" title="Driver Champion">🏆</span>'
        : ''
      const constructorBadge = season.isConstructorChampion
        ? '<span class="season-badge constructor" title="Constructor Champion">🏎</span>'
        : ''
      return `
        <span class="season-pill${
          season.isChampion ? ' driver-champ' : ''
        }${season.isConstructorChampion ? ' constructor-champ' : ''}">
          ${season.season}
          ${driverBadge}
          ${constructorBadge}
        </span>
      `
    })
    .join('')

  const renderChipBlocks = (blocks) =>
    blocks
      .map(
        (stat) => `
      <div class="stat-chip">
        <span class="chip-label">${stat.label}</span>
        <span class="chip-value">${stat.value}</span>
      </div>
    `
      )
      .join('')

  const overallStatBlocks = [
    { label: 'Seasons', value: totalSeasonsCount },
    { label: 'Active', value: `${firstSeason || '-'}–${lastSeason || '-'}` },
    { label: 'Wins', value: totalWins },
    { label: 'Titles', value: championships },
  ]

  const currentSeasonBlocks = []
  if (currentSeason) {
    const constructorLabel = currentSeason.constructors?.join(', ') || '–'
    currentSeasonBlocks.push(
      { label: 'Current Season', value: currentSeason.season },
      { label: 'Constructor', value: constructorLabel },
      { label: 'Standing', value: `P${currentSeason.position}` },
      { label: 'Points', value: currentSeason.points },
      { label: 'Wins (Season)', value: currentSeason.wins }
    )
    if (seasonResultsSummary) {
      currentSeasonBlocks.push({
        label: 'Avg Finish',
        value: seasonResultsSummary.avgFinish,
      })
    }
  } else if (seasonResultsSummary) {
    currentSeasonBlocks.push(
      { label: 'Races', value: seasonResultsSummary.races },
      { label: 'Avg Finish', value: seasonResultsSummary.avgFinish }
    )
  }

  const statHtmlSections = [renderChipBlocks(overallStatBlocks)]
  if (currentSeasonBlocks.length) {
    statHtmlSections.push('<div class="chip-divider"></div>')
    statHtmlSections.push(renderChipBlocks(currentSeasonBlocks))
  }
  const statHtml = statHtmlSections.join('')

  const gpRows = seasonResults.length
    ? seasonResults
        .map(
          (race) => `
        <div class="gp-row">
          <div class="gp-meta">
            <strong>${race.raceName}</strong>
            <span class="result-meta">${formatDate(race.date)}</span>
          </div>
          <div class="gp-metrics">
            <span>P${race.positionText}</span>
            <span>${race.points} pts</span>
            <span>Grid ${race.grid}</span>
            <span>${race.status}</span>
          </div>
        </div>
      `
        )
        .join('')
    : '<div class="empty-message">No race results available yet.</div>'

  return `
    <div class="f1-card horizontal-card">
      <div class="header-block">
      <div>
          <div class="driver-name">${driver.givenName} ${
    driver.familyName
  }</div>
          <div class="driver-meta-line">${driver.nationality} · Code ${
    driver.code || '-'
  }</div>
          <div class="driver-meta-line">DOB ${formattedDOB}</div>
        </div>
        <div class="chip-strip">${statHtml}</div>
      </div>
      <div class="season-timeline">
        ${seasonTimelineHtml}
    </div>
      <div class="main-content">
        <div class="content-column">
          <div class="season-section">
            <div class="section-title">All seasons</div>
      <div class="season-headings">
        <span>Season</span>
        <span>Team(s)</span>
        <span>Finish</span>
        <span>Points</span>
        <span>Wins</span>
      </div>
      ${seasonRows || '<div class="season-row">No season data yet.</div>'}
          </div>
        </div>
        <div class="content-column">
          <div class="section-block gp-section">
            <div class="section-title">Race results ${
              currentSeason?.season ? `(${currentSeason.season})` : ''
            }</div>
            <div class="gp-list">${gpRows}</div>
          </div>
        </div>
      </div>
    </div>
  `
}

function formatDate(value) {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

function handlePointerEnter(event) {
  const target = event.target.closest?.(`.${DRIVER_CLASS}`)
  if (!target) {
    return
  }
  clearTimeout(hideTimeout)
  const { pageX, pageY } = event
  handleDriverFocus(target, pageX, pageY)
}

function handlePointerLeave(event) {
  const target = event.target.closest?.(`.${DRIVER_CLASS}`)
  if (!target || target.dataset.driver !== activeSlug) {
    return
  }
  hideTimeout = setTimeout(() => {
    if (!popupHovered) {
      hidePopup()
    }
  }, 1000)
}

function handlePointerMove(event) {
  if (!pointerTracking || popupHovered) {
    return
  }
  // Popup stays centered, no need to follow cursor
}

function handleFocusIn(event) {
  const target = event.target.closest?.(`.${DRIVER_CLASS}`)
  if (!target) {
    return
  }
  const rect = target.getBoundingClientRect()
  const x = rect.left + window.scrollX
  const y = rect.top + window.scrollY
  handleDriverFocus(target, x, y)
}

function handleFocusOut(event) {
  const target = event.target.closest?.(`.${DRIVER_CLASS}`)
  if (!target || target.dataset.driver !== activeSlug) {
    return
  }
  hidePopup()
}

// Hardcoded fallback drivers list
const FALLBACK_DRIVERS = [
  { name: 'Max Verstappen', slug: 'max_verstappen', code: 'VER' },
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

async function loadDriversList() {
  try {
    const response = await new Promise((resolve, reject) => {
      if (!chrome?.runtime?.sendMessage) {
        reject(new Error('Extension messaging unavailable'))
        return
      }

      chrome.runtime.sendMessage({ type: 'fetch-drivers-list' }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message))
          return
        }

        if (!response) {
          reject(new Error('Empty response from background worker'))
          return
        }

        if (response.error) {
          reject(new Error(response.error))
          return
        }

        resolve(response.data)
      })
    })

    // Use response if it has drivers, otherwise use fallback
    if (response && Array.isArray(response) && response.length > 0) {
      DRIVER_DIRECTORY = response
      console.log(
        `F1 Hover Stats: Loaded ${DRIVER_DIRECTORY.length} drivers from API`
      )
    } else {
      console.warn('F1 Hover Stats: API returned empty list, using fallback')
      DRIVER_DIRECTORY = FALLBACK_DRIVERS
    }

    updateDriverLookup()
    driversListReady = true

    console.log(`F1 Hover Stats: Ready with ${DRIVER_DIRECTORY.length} drivers`)

    // Rescan the page now that we have drivers
    scanForDrivers(document.body)

    return DRIVER_DIRECTORY
  } catch (error) {
    console.error('F1 Hover Stats: Failed to load drivers list:', error)
    console.log('F1 Hover Stats: Using fallback drivers list')

    // Use fallback on error
    DRIVER_DIRECTORY = FALLBACK_DRIVERS
    updateDriverLookup()
    driversListReady = true

    // Rescan with fallback drivers
    scanForDrivers(document.body)

    return DRIVER_DIRECTORY
  }
}

function init() {
  console.log('F1 Hover Stats: Initializing...', {
    bodyExists: !!document.body,
    readyState: document.readyState,
    url: window.location.href,
  })

  // Visual indicator that script is running
  if (document.body) {
    const indicator = document.createElement('div')
    indicator.style.cssText =
      'position:fixed;top:10px;right:10px;background:#4CAF50;color:white;padding:8px 12px;border-radius:4px;z-index:999999;font-size:12px;font-family:sans-serif;box-shadow:0 2px 8px rgba(0,0,0,0.3);'
    indicator.textContent = 'F1 Hover Stats: Active'
    document.body.appendChild(indicator)
    setTimeout(() => indicator.remove(), 3000)
  }

  // Start loading drivers list asynchronously
  loadDriversList()
    .then(() => {
      console.log('F1 Hover Stats: Drivers loaded, rescanning page...')
      // Rescan after a short delay to catch any missed content
      setTimeout(() => {
        if (driversListReady && DRIVER_DIRECTORY.length > 0) {
          scanForDrivers(document.body)
          console.log('F1 Hover Stats: Page scan complete', {
            driversCount: DRIVER_DIRECTORY.length,
          })
        } else {
          console.warn('F1 Hover Stats: Drivers not ready', {
            driversListReady,
            driversCount: DRIVER_DIRECTORY.length,
          })
        }
      }, 500)
    })
    .catch((err) => {
      console.error('F1 Hover Stats: Init error:', err)
    })

  const observer = new MutationObserver((mutations) => {
    if (!driversListReady) return // Wait for drivers list to load

    for (const mutation of mutations) {
      mutation.addedNodes.forEach((node) => {
        if (
          node.nodeType === Node.TEXT_NODE ||
          node.nodeType === Node.ELEMENT_NODE
        ) {
          scanForDrivers(node)
        }
      })
    }
  })

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  })

  document.addEventListener('pointerenter', handlePointerEnter, true)
  document.addEventListener('pointerleave', handlePointerLeave, true)
  document.addEventListener('pointermove', handlePointerMove, true)
  document.addEventListener('focusin', handleFocusIn, true)
  document.addEventListener('focusout', handleFocusOut, true)
}

// Ensure we wait for the page to be ready
function startExtension() {
  if (document.body) {
    init()
  } else {
    // Wait for body to exist
    const bodyObserver = new MutationObserver((mutations, obs) => {
      if (document.body) {
        obs.disconnect()
        init()
      }
    })
    bodyObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
    })

    // Fallback timeout
    setTimeout(() => {
      if (document.body) {
        init()
      } else {
        console.error('F1 Hover Stats: document.body not found after timeout')
      }
    }, 5000)
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startExtension)
} else {
  startExtension()
}
