/**
 * Role definitions and assignment logic for the Mafia game.
 * 
 * Roles:
 *   MAFIA      - Kills one player per night. Knows other mafia members.
 *   DETECTIVE  - Investigates one player per night (learns if Mafia or not).
 *   DOCTOR     - Saves one player per night (can self-save once).
 *   VILLAGER   - No special ability. Votes during the day.
 * 
 * Role counts by player count:
 *   4-5  players: 1 Mafia, 1 Detective, 1 Doctor, rest Villagers
 *   6-8  players: 2 Mafia, 1 Detective, 1 Doctor, rest Villagers
 *   9-12 players: 3 Mafia, 1 Detective, 1 Doctor, rest Villagers
 */

const ROLES = {
  MAFIA: 'mafia',
  DETECTIVE: 'detective',
  DOCTOR: 'doctor',
  VILLAGER: 'villager',
};

const TEAMS = {
  MAFIA: 'mafia',
  VILLAGE: 'village',
};

const ROLE_META = {
  [ROLES.MAFIA]: {
    team: TEAMS.MAFIA,
    label: 'Mafia',
    emoji: '🔫',
    description: 'Eliminate villagers each night. Work with your fellow Mafia to take control.',
    nightAction: true,
  },
  [ROLES.DETECTIVE]: {
    team: TEAMS.VILLAGE,
    label: 'Detective',
    emoji: '🔍',
    description: 'Investigate one player each night to learn if they are Mafia or not.',
    nightAction: true,
  },
  [ROLES.DOCTOR]: {
    team: TEAMS.VILLAGE,
    label: 'Doctor',
    emoji: '💉',
    description: 'Protect one player each night from being eliminated. You may save yourself once.',
    nightAction: true,
  },
  [ROLES.VILLAGER]: {
    team: TEAMS.VILLAGE,
    label: 'Villager',
    emoji: '🏘️',
    description: 'Use your wits to identify and vote out the Mafia during the day.',
    nightAction: false,
  },
};

/**
 * Determine how many of each role to assign based on player count.
 * @param {number} playerCount
 * @returns {{ mafia: number, detective: number, doctor: number, villager: number }}
 */
function getRoleDistribution(playerCount) {
  if (playerCount < 4 || playerCount > 12) {
    throw new Error(`Invalid player count: ${playerCount}. Must be between 4 and 12.`);
  }

  let mafiaCount;
  if (playerCount <= 5) {
    mafiaCount = 1;
  } else if (playerCount <= 8) {
    mafiaCount = 2;
  } else {
    mafiaCount = 3;
  }

  const specialVillagers = 2; // detective + doctor
  const villagerCount = playerCount - mafiaCount - specialVillagers;

  return {
    [ROLES.MAFIA]: mafiaCount,
    [ROLES.DETECTIVE]: 1,
    [ROLES.DOCTOR]: 1,
    [ROLES.VILLAGER]: Math.max(0, villagerCount),
  };
}

/**
 * Shuffle an array in place using Fisher-Yates.
 * @param {Array} array
 * @returns {Array}
 */
function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

/**
 * Assign roles to an array of player IDs.
 * @param {string[]} playerIds
 * @returns {Map<string, string>} Map of playerId → role
 */
function assignRoles(playerIds) {
  const count = playerIds.length;
  const distribution = getRoleDistribution(count);

  const rolePool = [];
  for (const [role, num] of Object.entries(distribution)) {
    for (let i = 0; i < num; i++) {
      rolePool.push(role);
    }
  }

  shuffle(rolePool);

  const assignments = new Map();
  playerIds.forEach((id, index) => {
    assignments.set(id, rolePool[index]);
  });

  return assignments;
}

module.exports = {
  ROLES,
  TEAMS,
  ROLE_META,
  getRoleDistribution,
  assignRoles,
  shuffle,
};
