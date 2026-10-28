/*! Iris Kit profile helpers, MIT. Source: iris-kit@f412197215d78fb5fdb02f8a444f189d0bec1d8d, packages/svelte-ui/src/profile.ts. Type annotations removed; behavior unchanged. See LICENSE.txt. */
const coolNameAdjectives = [
  "Amber",
  "Analog",
  "Arcane",
  "Astral",
  "Aurora",
  "Azure",
  "Blissful",
  "Blooming",
  "Bold",
  "Bright",
  "Brilliant",
  "Calm",
  "Celestial",
  "Charming",
  "Clear",
  "Clever",
  "Cosmic",
  "Crimson",
  "Crystal",
  "Curious",
  "Daring",
  "Deep",
  "Dreamy",
  "Electric",
  "Emerald",
  "Ethereal",
  "Fabled",
  "Feral",
  "Festival",
  "Floating",
  "Fluent",
  "Free",
  "Friendly",
  "Gentle",
  "Glowing",
  "Golden",
  "Graceful",
  "Harmonic",
  "Hidden",
  "Honey",
  "Infinite",
  "Kind",
  "Laughing",
  "Liminal",
  "Lucid",
  "Lunar",
  "Lush",
  "Magnetic",
  "Mellow",
  "Mercury",
  "Midnight",
  "Mirrored",
  "Mystic",
  "Neon",
  "Nimble",
  "Noble",
  "Northern",
  "Nova",
  "Opal",
  "Open",
  "Pacific",
  "Patient",
  "Pearl",
  "Playful",
  "Polished",
  "Prismatic",
  "Quiet",
  "Radiant",
  "Restless",
  "River",
  "Ruby",
  "Saffron",
  "Secret",
  "Serene",
  "Signal",
  "Silver",
  "Solar",
  "Sparkling",
  "Spiral",
  "Stellar",
  "Still",
  "Stormy",
  "Sunny",
  "Swift",
  "Tender",
  "Verdant",
  "Velvet",
  "Vivid",
  "Warm",
  "Wandering",
  "Wild",
  "Wise",
  "Witty",
  "Wonder",
  "Zephyr"
];
const coolNameNouns = [
  "Anchor",
  "Archive",
  "Atlas",
  "Aurora",
  "Beacon",
  "Bloom",
  "Bridge",
  "Canvas",
  "Cascade",
  "Cipher",
  "Circuit",
  "Cloud",
  "Comet",
  "Compass",
  "Constellation",
  "Cove",
  "Daydream",
  "Drift",
  "Echo",
  "Ember",
  "Field",
  "Festival",
  "Flame",
  "Flux",
  "Forest",
  "Forge",
  "Fountain",
  "Garden",
  "Glacier",
  "Halo",
  "Harbor",
  "Harmony",
  "Hearth",
  "Horizon",
  "Lantern",
  "Library",
  "Lighthouse",
  "Lagoon",
  "Labyrinth",
  "Meadow",
  "Melody",
  "Mirage",
  "Mosaic",
  "Nebula",
  "Nimbus",
  "Nova",
  "Oasis",
  "Opal",
  "Orbit",
  "Orchard",
  "Paradox",
  "Pearl",
  "Planet",
  "Portal",
  "Prism",
  "Pulse",
  "Quartz",
  "Quest",
  "Radiance",
  "Rain",
  "Reef",
  "Riddle",
  "Ripple",
  "River",
  "Sanctuary",
  "Satellite",
  "Serenade",
  "Signal",
  "Solstice",
  "Spark",
  "Spectrum",
  "Spiral",
  "Starlight",
  "Station",
  "Studio",
  "Summit",
  "Sunrise",
  "Tempo",
  "Thread",
  "Tide",
  "Trail",
  "Valley",
  "Velvet",
  "Voyager",
  "Vortex",
  "Wave",
  "Wonder",
  "Zenith"
];
function text(value) {
  return typeof value === "string" ? value.trim() : "";
}
function normalizedSeed(seed) {
  return text(seed) || "iris";
}
function coolNameHash(seed) {
  let first = 2166136261;
  let second = 2246822507;
  for (let index = 0; index < seed.length; index += 1) {
    const code = seed.charCodeAt(index);
    first = Math.imul(first ^ code, 16777619);
    second = Math.imul(second ^ code, 2246822519);
  }
  return [first >>> 0, second >>> 0];
}
function coolName(seed) {
  const [first, second] = coolNameHash(normalizedSeed(seed));
  const adjective = coolNameAdjectives[first % coolNameAdjectives.length];
  const noun = coolNameNouns[second % coolNameNouns.length];
  return `${adjective} ${noun}`;
}
function getProfileName(profile) {
  return getProfileNameCandidates(profile)[0] ?? "";
}
function getProfileNameCandidates(profile) {
  if (!profile) return [];
  return uniqueTexts([
    profile.display_name,
    profile.displayName,
    profile.name,
    profile.username,
    profile.nickname
  ]);
}
function getProfilePicture(profile) {
  if (!profile) return "";
  return text(profile.picture) || text(profile.image);
}
function fallbackIdentityName(seed) {
  return coolName(seed);
}
function getProfileDisplayName(profile, pubkey, preferredName, fallbackName) {
  return text(preferredName) || getProfileName(profile) || text(fallbackName) || fallbackIdentityName(pubkey);
}
function hasExplicitProfileName(profile, preferredName) {
  return Boolean(text(preferredName) || getProfileName(profile));
}
function uniqueTexts(values) {
  const seen = /* @__PURE__ */ new Set();
  const result = [];
  for (const value of values) {
    const item = text(value);
    const key = item.toLocaleLowerCase();
    if (!item || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}
export {
  coolName,
  coolNameAdjectives,
  coolNameNouns,
  fallbackIdentityName,
  getProfileDisplayName,
  getProfileName,
  getProfileNameCandidates,
  getProfilePicture,
  hasExplicitProfileName
};
