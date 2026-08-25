// Tesla's three competition regions. Your region is the one where you visited the most unique
// Supercharger sites during the year (ties broken by total kWh charged there), and you only
// compete against participants of that region — while sessions anywhere in the world count
// toward your own stats.
//
// Note: the site database groups the Middle East under "Asia Pacific", but the contest counts
// it as EMEA (Europe, Middle East and Africa), so the mapping below is by country.

export const REGIONS = ['EMEA', 'Americas', 'Asia-Pacific', 'China'];

const AMERICAS = new Set([
  'USA', 'Canada', 'Mexico', 'Puerto Rico', 'Chile', 'Colombia', 'Brazil', 'Argentina', 'Peru', 'Uruguay', 'Costa Rica', 'Panama', 'Dominican Republic', 'Guatemala', 'Bahamas',
]);

const MIDDLE_EAST_AND_AFRICA = new Set([
  'Israel', 'Jordan', 'Oman', 'Qatar', 'Saudi Arabia', 'United Arab Emirates', 'Bahrain', 'Kuwait', 'Lebanon',
  'Morocco', 'Egypt', 'South Africa', 'Tunisia', 'Algeria', 'Kenya', 'Nigeria',
]);

const ASIA_PACIFIC = new Set([
  'Australia', 'New Zealand', 'Japan', 'South Korea', 'Taiwan', 'Singapore', 'Malaysia', 'Thailand', 'Philippines', 'India', 'Kazakhstan', 'Indonesia', 'Vietnam', 'Mongolia', 'Brunei',
]);

const EUROPE = new Set([
  'Austria', 'Belgium', 'Bosnia and Herzegovina', 'Bulgaria', 'Croatia', 'Cyprus', 'Czech Republic', 'Denmark', 'Estonia', 'Finland', 'France', 'Germany', 'Greece', 'Hungary',
  'Iceland', 'Ireland', 'Italy', 'Latvia', 'Liechtenstein', 'Lithuania', 'Luxembourg', 'Malta', 'Moldova', 'Monaco', 'Montenegro', 'Netherlands', 'North Macedonia', 'Norway',
  'Poland', 'Portugal', 'Romania', 'Serbia', 'Slovakia', 'Slovenia', 'Spain', 'Sweden', 'Switzerland', 'Turkey', 'Ukraine', 'United Kingdom',
]);

/** China (and its special administrative regions) runs a separate competition. */
const CHINA = new Set(['China', 'Hong Kong', 'Macau']);

/** Countries whose *residents* are excluded from the EMEA competition (site location is fine). */
export const EMEA_EXCLUDED_RESIDENCY = ['Italy', 'Portugal', 'Greece', 'Romania', 'Poland', 'Iceland', 'Estonia', 'United Arab Emirates', 'Saudi Arabia', 'Qatar'];

export function contestRegion(country) {
  if (!country) return 'Unknown';
  if (CHINA.has(country)) return 'China';
  if (AMERICAS.has(country)) return 'Americas';
  if (EUROPE.has(country) || MIDDLE_EAST_AND_AFRICA.has(country)) return 'EMEA';
  if (ASIA_PACIFIC.has(country)) return 'Asia-Pacific';
  return 'Unknown';
}

/**
 * Rank regions the way the contest does: most unique sites first, ties broken by kWh.
 * `rows` is [{ region, sites, kwh }]; the winner is the region you would be assigned to.
 */
export function rankRegions(rows) {
  return [...rows].sort((a, b) => (b.sites - a.sites) || (b.kwh - a.kwh) || a.region.localeCompare(b.region));
}
