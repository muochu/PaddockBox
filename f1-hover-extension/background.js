const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const DRIVERS_LIST_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const ERGAST_BASE_URL = "https://api.jolpi.ca/ergast/f1";
const cache = new Map();
let driversListCache = null;
let driversListExpiresAt = 0;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "fetch-driver") {
    handleDriverRequest(message.slug)
      .then((data) => sendResponse({ data }))
      .catch((error) => {
        console.error("F1 Hover Stats background:", error);
        sendResponse({ error: error.message || "Unknown error" });
      });
    return true;
  }

  if (message?.type === "fetch-drivers-list") {
    handleDriversListRequest()
      .then((data) => sendResponse({ data }))
      .catch((error) => {
        console.error("F1 Hover Stats background:", error);
        sendResponse({ error: error.message || "Unknown error" });
      });
    return true;
  }
});

async function handleDriverRequest(slug) {
  if (!slug) {
    throw new Error("Missing driver slug");
  }

  const cached = cache.get(slug);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.data;
  }

  const [driverInfoRes, seasonsRes] = await Promise.all([
    fetchJson(`${ERGAST_BASE_URL}/drivers/${slug}/`),
    fetchJson(`${ERGAST_BASE_URL}/drivers/${slug}/seasons/`)
  ]);

  const driver = driverInfoRes?.MRData?.DriverTable?.Drivers?.[0];
  const seasonsList =
    seasonsRes?.MRData?.SeasonTable?.Seasons?.map((season) => season.season) ?? [];

  const seasonsData = await fetchSeasonStandings(slug, seasonsList);

  const data = { driver, seasons: seasonsData };
  cache.set(slug, { data, expiresAt: now + CACHE_TTL_MS });
  return data;
}

async function fetchSeasonStandings(slug, seasons) {
  if (!Array.isArray(seasons) || seasons.length === 0) {
    return [];
  }

  const requests = seasons.map((season) =>
    fetchJson(`${ERGAST_BASE_URL}/${season}/drivers/${slug}/driverstandings/`)
      .then((res) => {
        const standing = res?.MRData?.StandingsTable?.StandingsLists?.[0]?.DriverStandings?.[0];
        if (!standing) {
          return null;
        }
        return {
          season,
          position: standing.position,
          points: standing.points,
          wins: Number(standing.wins) || 0,
          constructors: (standing.Constructors || []).map((team) => team.name)
        };
      })
      .catch((error) => {
        console.warn(`F1 Hover Stats background: Failed to fetch standings for ${season}/${slug}`, error);
        return null;
      })
  );

  const results = await Promise.all(requests);
  return results.filter(Boolean).sort((a, b) => Number(a.season) - Number(b.season));
}

async function handleDriversListRequest() {
  const now = Date.now();
  if (driversListCache && driversListExpiresAt > now) {
    console.log("F1 Hover Stats background: Returning cached drivers list", driversListCache.length);
    return driversListCache;
  }

  console.log("F1 Hover Stats background: Fetching drivers list...");

  try {
    // Try current season first
    console.log("F1 Hover Stats background: Trying current season endpoint...");
    const currentData = await fetchJson(`${ERGAST_BASE_URL}/current/drivers.json`);
    console.log("F1 Hover Stats background: Current season response:", currentData);
    const drivers = currentData?.MRData?.DriverTable?.Drivers ?? [];
    
    if (drivers.length > 0) {
      const list = drivers.map((driver) => ({
        name: `${driver.givenName} ${driver.familyName}`,
        slug: driver.driverId,
        code: driver.code || null
      }));
      
      console.log("F1 Hover Stats background: Loaded", list.length, "drivers from current season");
      driversListCache = list;
      driversListExpiresAt = now + DRIVERS_LIST_CACHE_TTL_MS;
      return list;
    } else {
      console.warn("F1 Hover Stats background: Current season returned 0 drivers");
    }
  } catch (error) {
    console.error("F1 Hover Stats background: Failed to fetch current drivers:", error);
  }

  // Fallback: fetch all drivers (last 3 seasons worth)
  console.log("F1 Hover Stats background: Trying fallback - last 3 seasons...");
  const currentYear = new Date().getFullYear();
  const allDrivers = new Map();
  
  for (let year = currentYear; year >= currentYear - 2; year--) {
    try {
      console.log(`F1 Hover Stats background: Fetching drivers for ${year}...`);
      const yearData = await fetchJson(`${ERGAST_BASE_URL}/${year}/drivers.json`);
      const yearDrivers = yearData?.MRData?.DriverTable?.Drivers ?? [];
      console.log(`F1 Hover Stats background: Found ${yearDrivers.length} drivers for ${year}`);
      yearDrivers.forEach((driver) => {
        if (!allDrivers.has(driver.driverId)) {
          allDrivers.set(driver.driverId, {
            name: `${driver.givenName} ${driver.familyName}`,
            slug: driver.driverId,
            code: driver.code || null
          });
        }
      });
    } catch (error) {
      console.error(`F1 Hover Stats background: Failed to fetch drivers for ${year}:`, error);
    }
  }

  const list = Array.from(allDrivers.values());
  console.log("F1 Hover Stats background: Total unique drivers found:", list.length);
  
  // If still no drivers, use hardcoded fallback
  if (list.length === 0) {
    console.warn("F1 Hover Stats background: No drivers from API, using hardcoded fallback");
    return [
      { name: "Max Verstappen", slug: "verstappen", code: "VER" },
      { name: "Sergio Pérez", slug: "perez", code: "PER" },
      { name: "Lewis Hamilton", slug: "hamilton", code: "HAM" },
      { name: "George Russell", slug: "russell", code: "RUS" },
      { name: "Charles Leclerc", slug: "leclerc", code: "LEC" },
      { name: "Carlos Sainz", slug: "sainz", code: "SAI" },
      { name: "Lando Norris", slug: "norris", code: "NOR" },
      { name: "Oscar Piastri", slug: "piastri", code: "PIA" },
      { name: "Fernando Alonso", slug: "alonso", code: "ALO" },
      { name: "Lance Stroll", slug: "stroll", code: "STR" },
      { name: "Esteban Ocon", slug: "ocon", code: "OCO" },
      { name: "Pierre Gasly", slug: "gasly", code: "GAS" },
      { name: "Alexander Albon", slug: "albon", code: "ALB" },
      { name: "Logan Sargeant", slug: "sargeant", code: "SAR" },
      { name: "Yuki Tsunoda", slug: "tsunoda", code: "TSU" },
      { name: "Daniel Ricciardo", slug: "ricciardo", code: "RIC" },
      { name: "Valtteri Bottas", slug: "bottas", code: "BOT" },
      { name: "Guanyu Zhou", slug: "zhou", code: "ZHO" },
      { name: "Kevin Magnussen", slug: "magnussen", code: "MAG" },
      { name: "Nico Hülkenberg", slug: "hulkenberg", code: "HUL" }
    ];
  }
  
  driversListCache = list;
  driversListExpiresAt = now + DRIVERS_LIST_CACHE_TTL_MS;
  return list;
}

async function fetchJson(url) {
  console.log("F1 Hover Stats background: Fetching", url);
  try {
    const response = await fetch(url, { cache: "no-store" });
    console.log("F1 Hover Stats background: Response status", response.status, "for", url);
    if (!response.ok) {
      throw new Error(`Request failed: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    console.log("F1 Hover Stats background: Successfully fetched", url);
    return data;
  } catch (error) {
    console.error("F1 Hover Stats background: Fetch error for", url, ":", error);
    throw error;
  }
}
