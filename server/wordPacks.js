/**
 * wordPacks.js — Word pair library for the Undercover game.
 *
 * Each pack entry is a [civilianWord, undercoverWord] pair.
 * Civilians get the first word, undercovers get the second (or vice versa — randomised).
 * The Blank (Mr. White) gets NO word at all.
 *
 * Design principles:
 *   - Words in a pair should be clearly related (same domain) but distinct enough
 *     that an undercover can bluff with vague clues without being instantly caught.
 *   - Difficulty levels: Easy (obvious pair), Medium (subtle), Hard (very close).
 */

const WORD_PACKS = {

  food: {
    label: 'Food & Drink',
    emoji: '🍕',
    pairs: [
      ['Pizza',        'Flatbread'],
      ['Sushi',        'Sashimi'],
      ['Burger',       'Sandwich'],
      ['Ice Cream',    'Gelato'],
      ['Coffee',       'Espresso'],
      ['Beer',         'Ale'],
      ['Tacos',        'Burritos'],
      ['Pancakes',     'Waffles'],
      ['Pasta',        'Noodles'],
      ['Cake',         'Muffin'],
      ['Chips',        'Crisps'],
      ['Milk',         'Cream'],
      ['Salad',        'Coleslaw'],
      ['Steak',        'Ribs'],
      ['Popcorn',      'Puffed Rice'],
      ['Doughnut',     'Bagel'],
      ['Whiskey',      'Bourbon'],
      ['Ketchup',      'Tomato Sauce'],
      ['Cereal',       'Granola'],
      ['Toast',        'Crouton'],
    ],
  },

  places: {
    label: 'Places',
    emoji: '🗺️',
    pairs: [
      ['Beach',        'Lake Shore'],
      ['Museum',       'Gallery'],
      ['Airport',      'Train Station'],
      ['Hospital',     'Clinic'],
      ['Cinema',       'Theatre'],
      ['Library',      'Bookshop'],
      ['Restaurant',   'Café'],
      ['Hotel',        'Hostel'],
      ['Stadium',      'Arena'],
      ['Zoo',          'Aquarium'],
      ['Park',         'Garden'],
      ['Supermarket',  'Grocery Store'],
      ['Gym',          'Sports Centre'],
      ['School',       'College'],
      ['Prison',       'Detention Centre'],
      ['Church',       'Mosque'],
      ['Casino',       'Arcade'],
      ['Bank',         'ATM'],
      ['Volcano',      'Mountain'],
      ['Desert',       'Savanna'],
    ],
  },

  animals: {
    label: 'Animals',
    emoji: '🦁',
    pairs: [
      ['Lion',         'Tiger'],
      ['Dolphin',      'Shark'],
      ['Eagle',        'Hawk'],
      ['Rabbit',       'Hare'],
      ['Crocodile',    'Alligator'],
      ['Penguin',      'Seal'],
      ['Wolf',         'Fox'],
      ['Butterfly',    'Moth'],
      ['Horse',        'Donkey'],
      ['Cat',          'Kitten'],
      ['Dog',          'Puppy'],
      ['Spider',       'Scorpion'],
      ['Gorilla',      'Chimpanzee'],
      ['Peacock',      'Parrot'],
      ['Frog',         'Toad'],
      ['Whale',        'Dolphin'],
      ['Cow',          'Buffalo'],
      ['Bee',          'Wasp'],
      ['Elephant',     'Mammoth'],
      ['Flamingo',     'Heron'],
    ],
  },

  movies: {
    label: 'Movies & TV',
    emoji: '🎬',
    pairs: [
      ['Horror Film',   'Thriller Film'],
      ['Comedy',        'Sitcom'],
      ['Documentary',   'Mockumentary'],
      ['Sequel',        'Remake'],
      ['Cinema',        'Streaming'],
      ['Trailer',       'Teaser'],
      ['Superhero',     'Action Hero'],
      ['Villain',       'Anti-hero'],
      ['Director',      'Producer'],
      ['Actor',         'Stunt Double'],
      ['Blockbuster',   'Indie Film'],
      ['Cartoon',       'Anime'],
      ['Script',        'Screenplay'],
      ['Oscar',         'Golden Globe'],
      ['Netflix',       'Prime Video'],
      ['Western',       'Samurai Film'],
      ['Musical',       'Opera'],
      ['Reboot',        'Spin-off'],
      ['VFX',           'CGI'],
      ['Box Office',    'Opening Weekend'],
    ],
  },

  jobs: {
    label: 'Jobs & Careers',
    emoji: '💼',
    pairs: [
      ['Doctor',        'Surgeon'],
      ['Lawyer',        'Judge'],
      ['Chef',          'Baker'],
      ['Teacher',       'Professor'],
      ['Pilot',         'Captain'],
      ['Journalist',    'Reporter'],
      ['Architect',     'Civil Engineer'],
      ['Firefighter',   'Paramedic'],
      ['Police Officer','Detective'],
      ['Accountant',    'Auditor'],
      ['Programmer',    'Software Engineer'],
      ['Designer',      'Illustrator'],
      ['Photographer',  'Videographer'],
      ['Nurse',         'Midwife'],
      ['Plumber',       'Electrician'],
      ['Astronaut',     'Cosmonaut'],
      ['Politician',    'Diplomat'],
      ['Psychologist',  'Psychiatrist'],
      ['Waiter',        'Bartender'],
      ['Driver',        'Chauffeur'],
    ],
  },

  sports: {
    label: 'Sports',
    emoji: '⚽',
    pairs: [
      ['Football',      'Rugby'],
      ['Tennis',        'Badminton'],
      ['Swimming',      'Water Polo'],
      ['Boxing',        'Wrestling'],
      ['Basketball',    'Netball'],
      ['Golf',          'Cricket'],
      ['Skiing',        'Snowboarding'],
      ['Marathon',      'Triathlon'],
      ['Cycling',       'Mountain Biking'],
      ['Volleyball',    'Beach Volleyball'],
      ['Baseball',      'Softball'],
      ['Gymnastics',    'Acrobatics'],
      ['Karate',        'Judo'],
      ['Surfing',       'Kitesurfing'],
      ['Archery',       'Javelin'],
      ['Ice Hockey',    'Field Hockey'],
      ['Rowing',        'Kayaking'],
      ['Fencing',       'Swordsmanship'],
      ['Darts',         'Bowling'],
      ['Horse Racing',  'Polo'],
    ],
  },

  nature: {
    label: 'Nature & Science',
    emoji: '🌿',
    pairs: [
      ['Thunder',       'Lightning'],
      ['River',         'Stream'],
      ['Earthquake',    'Tsunami'],
      ['Rainbow',       'Aurora'],
      ['Volcano',       'Geyser'],
      ['Cave',          'Tunnel'],
      ['Glacier',       'Iceberg'],
      ['Tornado',       'Hurricane'],
      ['Fossil',        'Amber'],
      ['Diamond',       'Crystal'],
      ['Oxygen',        'Carbon Dioxide'],
      ['Galaxy',        'Nebula'],
      ['Black Hole',    'Wormhole'],
      ['Atom',          'Molecule'],
      ['DNA',           'Gene'],
      ['Telescope',     'Microscope'],
      ['Experiment',    'Hypothesis'],
      ['Gravity',       'Magnetism'],
      ['Forest',        'Jungle'],
      ['Coral Reef',    'Seabed'],
    ],
  },

  tech: {
    label: 'Technology',
    emoji: '💻',
    pairs: [
      ['Smartphone',    'Tablet'],
      ['Password',      'PIN'],
      ['Virus',         'Malware'],
      ['App',           'Software'],
      ['Wi-Fi',         'Bluetooth'],
      ['Robot',         'Drone'],
      ['AI',            'Machine Learning'],
      ['Cloud',         'Server'],
      ['Browser',       'Search Engine'],
      ['Keyboard',      'Touchscreen'],
      ['Laptop',        'Desktop'],
      ['Camera',        'Webcam'],
      ['Headphones',    'Earbuds'],
      ['Charger',       'Power Bank'],
      ['Update',        'Upgrade'],
      ['Hack',          'Phishing'],
      ['Algorithm',     'Formula'],
      ['Email',         'Instant Message'],
      ['Download',      'Upload'],
      ['VPN',           'Proxy'],
    ],
  },

  household: {
    label: 'Household',
    emoji: '🏠',
    pairs: [
      ['Sofa',          'Armchair'],
      ['Fridge',        'Freezer'],
      ['Mirror',        'Window'],
      ['Curtains',      'Blinds'],
      ['Broom',         'Mop'],
      ['Towel',         'Bathrobe'],
      ['Pillow',        'Cushion'],
      ['Wardrobe',      'Closet'],
      ['Washing Machine','Dryer'],
      ['Oven',          'Microwave'],
      ['Fork',          'Chopsticks'],
      ['Kettle',        'Toaster'],
      ['Vacuum',        'Dustpan'],
      ['Soap',          'Shampoo'],
      ['Candle',        'Lantern'],
      ['Clock',         'Timer'],
      ['Doorbell',      'Knocker'],
      ['Carpet',        'Rug'],
      ['Bathtub',       'Shower'],
      ['Stairs',        'Escalator'],
    ],
  },

  history: {
    label: 'History & Culture',
    emoji: '🏛️',
    pairs: [
      ['Emperor',       'King'],
      ['Revolution',    'Rebellion'],
      ['Pyramid',       'Temple'],
      ['Knight',        'Samurai'],
      ['Viking',        'Pirate'],
      ['Philosopher',   'Scholar'],
      ['Gladiator',     'Warrior'],
      ['Slavery',       'Serfdom'],
      ['Colony',        'Territory'],
      ['Treaty',        'Alliance'],
      ['Throne',        'Crown'],
      ['Cathedral',     'Fortress'],
      ['Manuscript',    'Scroll'],
      ['Legend',        'Myth'],
      ['Expedition',    'Quest'],
      ['Plague',        'Epidemic'],
      ['Coronation',    'Inauguration'],
      ['Exile',         'Banishment'],
      ['Monument',      'Memorial'],
      ['Prophecy',      'Oracle'],
    ],
  },

  emotions: {
    label: 'Emotions & Actions',
    emoji: '😊',
    pairs: [
      ['Happy',         'Excited'],
      ['Sad',           'Disappointed'],
      ['Angry',         'Frustrated'],
      ['Surprised',     'Shocked'],
      ['Scared',        'Nervous'],
      ['Jealous',       'Envious'],
      ['Bored',         'Restless'],
      ['Proud',         'Confident'],
      ['Guilty',        'Ashamed'],
      ['Lonely',        'Isolated'],
      ['Laugh',         'Giggle'],
      ['Cry',           'Sob'],
      ['Shout',         'Whisper'],
      ['Run',           'Sprint'],
      ['Sleep',         'Nap'],
      ['Dream',         'Daydream'],
      ['Forgive',       'Forget'],
      ['Lie',           'Deceive'],
      ['Trust',         'Believe'],
      ['Love',          'Adore'],
    ],
  },

  fantasy: {
    label: 'Fantasy & Myth',
    emoji: '🐉',
    pairs: [
      ['Dragon',        'Wyvern'],
      ['Wizard',        'Sorcerer'],
      ['Elf',           'Fairy'],
      ['Vampire',       'Werewolf'],
      ['Castle',        'Fortress'],
      ['Potion',        'Elixir'],
      ['Spell',         'Curse'],
      ['Sword',         'Dagger'],
      ['Quest',         'Journey'],
      ['Monster',       'Beast'],
      ['Oracle',        'Prophet'],
      ['Dungeon',       'Labyrinth'],
      ['Treasure',      'Relic'],
      ['Unicorn',       'Pegasus'],
      ['Witch',         'Warlock'],
      ['Shield',        'Armour'],
      ['Throne',        'Altar'],
      ['Mermaid',       'Siren'],
      ['Ghost',         'Phantom'],
      ['Portal',        'Gateway'],
    ],
  },

  music: {
    label: 'Music',
    emoji: '🎵',
    pairs: [
      ['Guitar',        'Bass Guitar'],
      ['Violin',        'Viola'],
      ['Piano',         'Keyboard'],
      ['Drums',         'Bongos'],
      ['Trumpet',       'Trombone'],
      ['Singer',        'Rapper'],
      ['Concert',       'Festival'],
      ['Album',         'EP'],
      ['Rock',          'Metal'],
      ['Jazz',          'Blues'],
      ['Chorus',        'Verse'],
      ['Headphones',    'Speaker'],
      ['DJ',            'Producer'],
      ['Microphone',    'Speaker'],
      ['Sheet Music',   'Music Tab'],
      ['Opera',         'Classical Music'],
      ['Remix',         'Cover'],
      ['Hip-Hop',       'R&B'],
      ['Beat',          'Rhythm'],
      ['Lyrics',        'Poem'],
    ],
  },

  bodyAndHealth: {
    label: 'Body & Health',
    emoji: '💪',
    pairs: [
      ['Heart',         'Lung'],
      ['Brain',         'Mind'],
      ['Muscle',        'Tendon'],
      ['Fever',         'Flu'],
      ['Vitamin',       'Supplement'],
      ['Surgery',       'Operation'],
      ['Vaccine',       'Injection'],
      ['Dentist',       'Orthodontist'],
      ['Diet',          'Fast'],
      ['Yoga',          'Pilates'],
      ['Headache',      'Migraine'],
      ['Allergy',       'Rash'],
      ['Bandage',       'Cast'],
      ['Meditation',    'Mindfulness'],
      ['Sleep',         'Rest'],
      ['Heartbeat',     'Pulse'],
      ['Blood',         'Plasma'],
      ['Skeleton',      'Bones'],
      ['Sneeze',        'Cough'],
      ['Therapist',     'Counsellor'],
    ],
  },

  fashion: {
    label: 'Fashion & Style',
    emoji: '👗',
    pairs: [
      ['Dress',         'Skirt'],
      ['Jeans',         'Trousers'],
      ['Sneakers',      'Trainers'],
      ['Hoodie',        'Sweatshirt'],
      ['Ring',          'Bracelet'],
      ['Sunglasses',    'Goggles'],
      ['Hat',           'Cap'],
      ['Coat',          'Jacket'],
      ['Suit',          'Blazer'],
      ['Lipstick',      'Lip Gloss'],
      ['Perfume',       'Cologne'],
      ['Silk',          'Satin'],
      ['Vintage',       'Retro'],
      ['Model',         'Influencer'],
      ['Brand',         'Label'],
      ['Runway',        'Catwalk'],
      ['Scarf',         'Shawl'],
      ['Boots',         'Heels'],
      ['Tie',           'Bow Tie'],
      ['Underwear',     'Lingerie'],
    ],
  },

  vehicles: {
    label: 'Vehicles & Transport',
    emoji: '🚗',
    pairs: [
      ['Car',           'Van'],
      ['Motorbike',     'Scooter'],
      ['Plane',         'Helicopter'],
      ['Ship',          'Ferry'],
      ['Train',         'Tram'],
      ['Bicycle',       'Tricycle'],
      ['Submarine',     'Diving Bell'],
      ['Rocket',        'Shuttle'],
      ['Tank',          'Armoured Car'],
      ['Taxi',          'Ride-Share'],
      ['Bus',           'Coach'],
      ['Truck',         'Lorry'],
      ['Speedboat',     'Jet Ski'],
      ['Hot Air Balloon','Zeppelin'],
      ['Cable Car',     'Gondola'],
      ['Hovercraft',    'Hydrofoil'],
      ['Ambulance',     'Fire Engine'],
      ['Yacht',         'Sailboat'],
      ['Caravan',       'Camper Van'],
      ['Forklift',      'Crane'],
    ],
  },

};

/**
 * Get a random word pair from a category.
 * Returns { wordA, wordB, category } with wordA/B randomly swapped
 * so the "civilian word" isn't always the first.
 *
 * @param {string} categoryKey
 * @returns {{ wordA: string, wordB: string, category: string, categoryLabel: string }}
 */
function getRandomPair(categoryKey) {
  const pack = WORD_PACKS[categoryKey];
  if (!pack) throw new Error(`Unknown category: ${categoryKey}`);

  const pairs = pack.pairs;
  const pair = pairs[Math.floor(Math.random() * pairs.length)];

  // Randomly decide which word is "civilian" and which is "undercover"
  const swapped = Math.random() < 0.5;
  return {
    wordA: swapped ? pair[1] : pair[0],   // civilian word
    wordB: swapped ? pair[0] : pair[1],   // undercover word
    category: categoryKey,
    categoryLabel: pack.label,
  };
}

/**
 * Get a random pair from any category.
 */
function getRandomPairFromAny() {
  const keys = Object.keys(WORD_PACKS);
  const key = keys[Math.floor(Math.random() * keys.length)];
  return getRandomPair(key);
}

/**
 * Validate a custom word pair submitted by admin.
 */
function validateCustomPair(wordA, wordB) {
  if (!wordA || !wordB) return { valid: false, error: 'Both words are required.' };
  if (wordA.trim().length < 1 || wordA.trim().length > 40) return { valid: false, error: 'Word A must be 1–40 characters.' };
  if (wordB.trim().length < 1 || wordB.trim().length > 40) return { valid: false, error: 'Word B must be 1–40 characters.' };
  if (wordA.trim().toLowerCase() === wordB.trim().toLowerCase()) return { valid: false, error: 'The two words must be different.' };
  return { valid: true };
}

/**
 * List all available categories (for admin UI).
 */
function getCategoryList() {
  return Object.entries(WORD_PACKS).map(([key, pack]) => ({
    key,
    label: pack.label,
    emoji: pack.emoji,
    pairCount: pack.pairs.length,
  }));
}

module.exports = {
  WORD_PACKS,
  getRandomPair,
  getRandomPairFromAny,
  validateCustomPair,
  getCategoryList,
};
