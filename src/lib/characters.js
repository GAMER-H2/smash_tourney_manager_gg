// Icon filenames match Smash Ultimate's internal one-word fighter codenames
// (as datamined from the game itself), not the English display names -
// e.g. Bowser -> "koopa", Jigglypuff -> "purin", Villager -> "murabito".
const CHARACTER_ICON_FILES = {
  Mario: "mario",
  "Donkey Kong": "donkey",
  Link: "link",
  Samus: "samus",
  "Dark Samus": "samusd",
  Yoshi: "yoshi",
  Kirby: "kirby",
  Fox: "fox",
  Pikachu: "pikachu",
  Luigi: "luigi",
  Ness: "ness",
  "Captain Falcon": "captain",
  Jigglypuff: "purin",
  Peach: "peach",
  Daisy: "daisy",
  Bowser: "koopa",
  "Ice Climbers": "ice_climber",
  Sheik: "sheik",
  Zelda: "zelda",
  "Dr. Mario": "mariod",
  Pichu: "pichu",
  Falco: "falco",
  Marth: "marth",
  Lucina: "lucina",
  "Young Link": "younglink",
  Ganondorf: "ganon",
  Mewtwo: "mewtwo",
  Roy: "roy",
  Chrom: "chrom",
  "Mr. Game & Watch": "gamewatch",
  "Meta Knight": "metaknight",
  Pit: "pit",
  "Dark Pit": "pitb",
  "Zero Suit Samus": "szerosuit",
  Wario: "wario",
  Snake: "snake",
  Ike: "ike",
  "Pok\u00e9mon Trainer": "ptrainer",
  "Diddy Kong": "diddy",
  Lucas: "lucas",
  Sonic: "sonic",
  "King Dedede": "dedede",
  Olimar: "pikmin",
  Lucario: "lucario",
  "R.O.B.": "robot",
  "Toon Link": "toonlink",
  Wolf: "wolf",
  Villager: "murabito",
  "Mega Man": "rockman",
  "Wii Fit Trainer": "wiifit",
  "Rosalina & Luma": "rosetta",
  "Little Mac": "littlemac",
  Greninja: "gekkouga",
  "Mii Brawler": "miifighter",
  "Mii Swordfighter": "miiswordsman",
  "Mii Gunner": "miigunner",
  Palutena: "palutena",
  "Pac-Man": "pacman",
  Robin: "reflet",
  Shulk: "shulk",
  "Bowser Jr.": "koopajr",
  "Duck Hunt": "duckhunt",
  Ryu: "ryu",
  Ken: "ken",
  Cloud: "cloud",
  Corrin: "kamui",
  Bayonetta: "bayonetta",
  Inkling: "inkling",
  Ridley: "ridley",
  Simon: "simon",
  Richter: "richter",
  "King K. Rool": "krool",
  Isabelle: "shizue",
  Incineroar: "gaogaen",
  "Piranha Plant": "packun",
  Joker: "jack",
  Hero: "brave",
  "Banjo & Kazooie": "buddy",
  Terry: "dolly",
  Byleth: "master",
  "Min Min": "tantan",
  Steve: "pickel",
  Sephiroth: "edge",
  "Pyra/Mythra": "eflame",
  Kazuya: "demon",
  Sora: "trail",
};

export const RANDOM_CHARACTER = "Random";

export function characterIconSrc(name) {
  const file = CHARACTER_ICON_FILES[name];
  return file ? `/character-icons/${file}.png` : null;
}

// The bare icon filename (no extension/path), used to tell the Tauri backend
// which bundled PNG to stage next to program_state.json for the stream
// overlay - distinct from characterIconSrc(), which is a dev-server URL only
// this app's own webview can resolve.
export function characterIconFile(name) {
  return CHARACTER_ICON_FILES[name] || null;
}

// Random has no artwork - it's always shown as a plain "?" rather than
// falling back to its first letter like an unrecognized character would.
export function characterIconLabel(name) {
  // Names pulled from start.gg's own character list don't necessarily match
  // our RANDOM_CHARACTER constant exactly (e.g. different casing/wording),
  // so match loosely rather than requiring an exact "Random".
  return /random/i.test(name) ? "?" : name.charAt(0);
}

export const SMASH_ULTIMATE_CHARACTERS = [
  "Random",
  "Mario",
  "Donkey Kong",
  "Link",
  "Samus",
  "Dark Samus",
  "Yoshi",
  "Kirby",
  "Fox",
  "Pikachu",
  "Luigi",
  "Ness",
  "Captain Falcon",
  "Jigglypuff",
  "Peach",
  "Daisy",
  "Bowser",
  "Ice Climbers",
  "Sheik",
  "Zelda",
  "Dr. Mario",
  "Pichu",
  "Falco",
  "Marth",
  "Lucina",
  "Young Link",
  "Ganondorf",
  "Mewtwo",
  "Roy",
  "Chrom",
  "Mr. Game & Watch",
  "Meta Knight",
  "Pit",
  "Dark Pit",
  "Zero Suit Samus",
  "Wario",
  "Snake",
  "Ike",
  "Pokémon Trainer",
  "Diddy Kong",
  "Lucas",
  "Sonic",
  "King Dedede",
  "Olimar",
  "Lucario",
  "R.O.B.",
  "Toon Link",
  "Wolf",
  "Villager",
  "Mega Man",
  "Wii Fit Trainer",
  "Rosalina & Luma",
  "Little Mac",
  "Greninja",
  "Mii Brawler",
  "Mii Swordfighter",
  "Mii Gunner",
  "Palutena",
  "Pac-Man",
  "Robin",
  "Shulk",
  "Bowser Jr.",
  "Duck Hunt",
  "Ryu",
  "Ken",
  "Cloud",
  "Corrin",
  "Bayonetta",
  "Inkling",
  "Ridley",
  "Simon",
  "Richter",
  "King K. Rool",
  "Isabelle",
  "Incineroar",
  "Piranha Plant",
  "Joker",
  "Hero",
  "Banjo & Kazooie",
  "Terry",
  "Byleth",
  "Min Min",
  "Steve",
  "Sephiroth",
  "Pyra/Mythra",
  "Kazuya",
  "Sora",
];

function normalizeCharacterKey(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

// start.gg sometimes spells split/hyphenated character names differently
// from our own list (e.g. its "Pyra & Mythra" vs our "Pyra/Mythra", or its
// "Banjo-Kazooie" vs our "Banjo & Kazooie"). Comparing with punctuation and
// case stripped out matches these variants without hardcoding each pair -
// both reduce to "pyramythra" / "banjokazooie" either way.
const NORMALIZED_CHARACTER_LOOKUP = new Map(
  SMASH_ULTIMATE_CHARACTERS.map((name) => [normalizeCharacterKey(name), name]),
);

// Resolves a name from anywhere (our own picker, or pulled in from start.gg)
// to our canonical character name, so icon lookups, picker highlighting, and
// matching start.gg's own characterId when submitting all agree on one
// spelling. Falls back to the original name if nothing matches.
export function canonicalCharacterName(name) {
  if (!name) return name;
  if (/random/i.test(name)) return RANDOM_CHARACTER;
  return NORMALIZED_CHARACTER_LOOKUP.get(normalizeCharacterKey(name)) || name;
}
