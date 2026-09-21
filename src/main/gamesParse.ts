/**
 * Rozpoznání běžící hry - čistá část (bez spouštění procesů), s testem.
 *
 * Zdroje, od nejspolehlivějšího:
 *  1. Okno v popředí (pomocník na Windows, main/winHelper.ts): která hra
 *     je opravdu před hráčem, když běží víc programů - CS2 v popředí
 *     vyhraje nad Robloxem zapomenutým na pozadí.
 *  2. Steam: v registru drží RunningAppID hry, která právě běží, a její
 *     název je v appmanifest_<id>.acf ve složce knihovny.
 *  3. Hry, které si hráč přidal sám (název .exe -> název hry).
 *  4. Seznam známých her mimo Steam (Riot, Epic, Battle.net, Minecraft,
 *     Roblox, EA, Ubisoft...) podle názvu spustitelného souboru.
 *  5. Neznámý program přes celou obrazovku bez rámečku v popředí - hry
 *     tak běží skoro všechny; pojmenuje se podle programu a hráč ho může
 *     v nastavení přejmenovat.
 *
 * Seznam procesů dává na Windows `tasklist /FO CSV /NH`.
 */

export type DetectedGame = {
  name: string;
  /** Spustitelný soubor (malými písmeny), nebo "steam:<appid>". */
  exe: string;
  /** Odkud to víme. */
  source: 'steam' | 'custom' | 'known' | 'fullscreen';
};

/** Co pomocník na Windows říká o okně v popředí (viz winHelper.ts). */
export type ForegroundLike = { exe: string; title: string; fullscreen: boolean };

export type ChooseInput = {
  /** Běžící procesy (malými písmeny s .exe). */
  processes: Set<string>;
  custom: Record<string, string>;
  /** Hra podle Steamu (RunningAppID), nebo null. */
  steam: DetectedGame | null;
  /** Okno v popředí, nebo null (pomocník neběží / není Windows). */
  foreground: ForegroundLike | null;
  /** Procesy s vlastním oknem (z pomocníka); prázdná množina = nevíme. */
  windowed: Set<string>;
  /** Hra z minulého kola - drží se, dokud její proces běží. */
  current: DetectedGame | null;
  /** Brát neznámý program přes celou obrazovku jako hru. */
  fullscreenDetection: boolean;
  /** Minecraft Java potvrzený příkazovou řádkou (javaw.exe), nebo null. */
  minecraft: DetectedGame | null;
};

/**
 * Vybere hru z toho, co běží. Pravidla (s pomocníkem, tj. když víme, co
 * je v popředí):
 *  1. hra, jejíž okno je v popředí, vyhrává (i nad Steamem - ten jen
 *     doplní hezký název, když program neznáme);
 *  2. neznámý program v popředí přes celou obrazovku bez rámečku = hra
 *     (když je to zapnuté a není to prohlížeč, launcher, přehrávač…);
 *     neznámý program v popředí, zatímco Steam hlásí běžící hru = ta hra;
 *  3. hra z minulého kola zůstává, dokud běží (alt-tab do Discordu ji
 *     neukončí);
 *  4. jinak NIC - hra, která běží někde na pozadí a hráč ji nemá před
 *     sebou (zapomenutý Roblox), se nehraje. Po zavření CS2 tak appka
 *     správně čeká na další hru, místo aby "hrála Roblox".
 * Bez pomocníka (Linux/macOS, nebo když spadl) se bere první kandidát,
 * přednostně takový, který má vlastní okno.
 */
export function chooseGame(input: ChooseInput): DetectedGame | null {
  const candidates: DetectedGame[] = [];
  for (const [exe, name] of Object.entries(input.custom)) {
    if (input.processes.has(exe.toLowerCase())) candidates.push({ name, exe: exe.toLowerCase(), source: 'custom' });
  }
  for (const exe of input.processes) {
    const known = KNOWN_GAMES[exe];
    if (known && !WEAK_EXES.has(exe) && !candidates.some((c) => c.exe === exe)) candidates.push({ name: known, exe, source: 'known' });
  }
  if (input.minecraft) candidates.push(input.minecraft);
  if (input.steam) candidates.push(input.steam);

  const fg = input.foreground;
  if (fg?.exe) {
    const inFront = candidates.find((c) => c.exe === fg.exe);
    if (inFront) return inFront;
    if (!IGNORED_FOREGROUND.has(fg.exe) && !fg.exe.startsWith('kine')) {
      if (input.steam) {
        // Steam ví, co běží, ale ne pod jakým programem - když je v popředí
        // neznámý program a Steam hlásí hru, je to ona (okno i celá obrazovka).
        return { name: input.steam.name, exe: fg.exe, source: 'steam' };
      }
      if (fg.fullscreen && input.fullscreenDetection) {
        return { name: input.custom[fg.exe] ?? prettyNameFromExe(fg.exe, fg.title), exe: fg.exe, source: 'fullscreen' };
      }
    }
  }

  if (input.current) {
    const stillRunning = input.current.exe.startsWith('steam:') ? input.steam?.exe === input.current.exe : input.processes.has(input.current.exe);
    if (stillRunning) {
      const fresh = candidates.find((c) => c.exe === input.current!.exe);
      return fresh ?? input.current;
    }
  }

  // S pomocníkem víme, že žádná hra není před hráčem - nehádat.
  if (fg) return null;

  if (candidates.length === 0) return null;
  const withWindow = candidates.find((c) => input.windowed.has(c.exe));
  return withWindow ?? candidates[0];
}

/**
 * Název hry z názvu programu, když nic lepšího není:
 * "fortniteclient-win64-shipping.exe" -> "Fortnite Client". Krátký
 * titulek okna bez cest a pomlček je lepší ("Hollow Knight").
 */
export function prettyNameFromExe(exe: string, title = ''): string {
  const cleanTitle = title.trim();
  if (cleanTitle && cleanTitle.length <= 40 && !/[\\/|<>]/.test(cleanTitle) && !/\.exe$/i.test(cleanTitle) && !/\d+\.\d+\.\d+/.test(cleanTitle)) {
    return cleanTitle;
  }
  let base = exe.replace(/\.exe$/i, '');
  base = base.replace(/[-_]?(win64|win32|x64|x86|shipping|steam|dx11|dx12|launcher|client)(?=$|[-_])/gi, '');
  base = base.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!base) base = exe;
  return base
    .split(' ')
    .filter(Boolean)
    .map((w) => (w.length <= 3 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(' ');
}

/**
 * Programy, které nejsou hra, i když běží přes celou obrazovku:
 * systém, prohlížeče, launchery, přehrávače, overlaye. Zároveň se
 * nenabízí v nastavení jako "hra".
 */
export const IGNORED_FOREGROUND = new Set([
  'system', 'system idle process', 'registry', 'smss.exe', 'csrss.exe', 'wininit.exe', 'services.exe', 'lsass.exe',
  'svchost.exe', 'winlogon.exe', 'fontdrvhost.exe', 'dwm.exe', 'explorer.exe', 'sihost.exe', 'taskhostw.exe',
  'runtimebroker.exe', 'searchhost.exe', 'startmenuexperiencehost.exe', 'shellexperiencehost.exe', 'ctfmon.exe',
  'conhost.exe', 'dllhost.exe', 'spoolsv.exe', 'audiodg.exe', 'wudfhost.exe', 'memory compression', 'securityhealthservice.exe',
  'securityhealthsystray.exe', 'msmpeng.exe', 'nissrv.exe', 'textinputhost.exe', 'applicationframehost.exe',
  'systemsettings.exe', 'lockapp.exe', 'wmiprvse.exe', 'msedgewebview2.exe', 'widgets.exe', 'taskmgr.exe',
  'tasklist.exe', 'reg.exe', 'powershell.exe', 'pwsh.exe', 'cmd.exe', 'windowsterminal.exe', 'onedrive.exe',
  'steam.exe', 'steamwebhelper.exe', 'steamservice.exe', 'discord.exe', 'chrome.exe', 'msedge.exe', 'firefox.exe',
  'opera.exe', 'opera_gx.exe', 'brave.exe', 'vivaldi.exe', 'iexplore.exe', 'spotify.exe', 'epicgameslauncher.exe',
  'epicwebhelper.exe', 'riotclientservices.exe', 'riotclientux.exe', 'leagueclient.exe', 'leagueclientux.exe',
  'battle.net.exe', 'agent.exe', 'ubisoftconnect.exe', 'upc.exe', 'eadesktop.exe', 'eabackgroundservice.exe',
  'galaxyclient.exe', 'nvcontainer.exe', 'nvidia share.exe', 'nvdisplay.container.exe', 'nvidia app.exe',
  'radeonsoftware.exe', 'amdrsserv.exe', 'obs64.exe', 'obs32.exe', 'medal.exe', 'overwolf.exe', 'wallpaper64.exe',
  'wallpaper32.exe', 'vlc.exe', 'mpc-hc64.exe', 'mpc-hc.exe', 'wmplayer.exe', 'potplayermini64.exe', 'mpv.exe',
  'netflix.exe', 'video.ui.exe', 'photos.exe', 'microsoft.photos.exe', 'powerpnt.exe', 'winword.exe', 'excel.exe',
  'acrobat.exe', 'code.exe', 'teams.exe', 'ms-teams.exe', 'zoom.exe', 'slack.exe', 'telegram.exe', 'whatsapp.exe',
  'kine.exe', 'electron.exe', 'ffmpeg.exe', 'ps', 'bash', 'sh', 'zsh',
  'systemd', 'init', 'kthreadd', 'dbus-daemon', 'pulseaudio', 'pipewire', 'xorg', 'gnome-shell',
]);

/** Řádky `tasklist /FO CSV /NH`: "Image Name","PID","Session Name","Session#","Mem Usage". */
export function parseTasklistCsv(text: string): Set<string> {
  const names = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^"([^"]+)"/.exec(line.trim());
    if (m) names.add(m[1].toLowerCase());
  }
  return names;
}

/** Výstup `ps -eo comm=` (Linux/macOS, jen pro vývoj). */
export function parsePsList(text: string): Set<string> {
  const names = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const name = line.trim().toLowerCase();
    if (name) names.add(name.split('/').pop() as string);
  }
  return names;
}

/**
 * Výstup `reg query HKCU\Software\Valve\Steam /v RunningAppID`:
 *     RunningAppID    REG_DWORD    0x2f0
 * Nula = nic neběží. Vrací id hry nebo 0.
 */
export function parseSteamRunningAppId(text: string): number {
  const m = /RunningAppID\s+REG_DWORD\s+(0x[0-9a-f]+|\d+)/i.exec(text);
  if (!m) return 0;
  const value = m[1].toLowerCase().startsWith('0x') ? parseInt(m[1], 16) : parseInt(m[1], 10);
  return Number.isFinite(value) ? value : 0;
}

/** Výstup `reg query HKCU\Software\Valve\Steam /v SteamPath` -> cesta ke Steamu. */
export function parseSteamPath(text: string): string | null {
  const m = /SteamPath\s+REG_SZ\s+(.+)$/im.exec(text);
  return m ? m[1].trim().replace(/\//g, '\\') : null;
}

/** Cesty knihoven z steamapps/libraryfolders.vdf ("path" "D:\\Hry\\SteamLibrary"). */
export function parseLibraryFolders(vdf: string): string[] {
  const paths: string[] = [];
  const re = /"path"\s+"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(vdf))) paths.push(m[1].replace(/\\\\/g, '\\'));
  return paths;
}

/** Název hry z appmanifest_<id>.acf ("name" "Counter-Strike 2"). */
export function parseAcfName(acf: string): string | null {
  const m = /"name"\s+"((?:[^"\\]|\\.)*)"/.exec(acf);
  return m ? m[1].replace(/\\"/g, '"').trim() || null : null;
}

/**
 * Hra podle seznamu procesů. Přednost mají hry přidané hráčem, pak
 * seznam známých. Vrací null, když nic nesedí.
 *
 * `weak` položky (javaw.exe = Minecraft Java) se potvrzují zvlášť podle
 * příkazové řádky - to už není čistá funkce, dělá to volající přes
 * `needsConfirmation`.
 */
export function detectFromProcesses(processes: Set<string>, custom: Record<string, string>): DetectedGame | null {
  for (const [exe, name] of Object.entries(custom)) {
    if (processes.has(exe.toLowerCase())) return { name, exe: exe.toLowerCase(), source: 'custom' };
  }
  for (const exe of processes) {
    const known = KNOWN_GAMES[exe];
    if (known && !WEAK_EXES.has(exe)) return { name: known, exe, source: 'known' };
  }
  return null;
}

/** Procesy, u kterých se musí ověřit příkazová řádka (java není vždycky Minecraft). */
export function needsConfirmation(processes: Set<string>): string[] {
  return [...WEAK_EXES].filter((exe) => processes.has(exe));
}

/** Je tahle příkazová řádka Minecraft? */
export function isMinecraftCommandLine(cmdline: string): boolean {
  return /minecraft|net\.minecraft|lunarclient|feather|badlion|fabric|forge|optifine|prismlauncher|multimc|tlauncher/i.test(cmdline);
}

export const WEAK_EXES = new Set(['javaw.exe', 'java.exe']);

/**
 * Známé hry mimo Steam (a názvy pro ty na Steamu, kdyby registr selhal).
 * Klíč je název souboru malými písmeny přesně tak, jak ho ukazuje
 * Správce úloh / tasklist.
 */
export const KNOWN_GAMES: Record<string, string> = {
  // střílečky
  'cs2.exe': 'Counter-Strike 2',
  'csgo.exe': 'Counter-Strike: Global Offensive',
  'valorant-win64-shipping.exe': 'VALORANT',
  'fortniteclient-win64-shipping.exe': 'Fortnite',
  'r5apex.exe': 'Apex Legends',
  'r5apex_dx12.exe': 'Apex Legends',
  'overwatch.exe': 'Overwatch 2',
  'rainbowsix.exe': 'Rainbow Six Siege',
  'rainbowsix_dx11.exe': 'Rainbow Six Siege',
  'rainbowsix_be.exe': 'Rainbow Six Siege',
  'escapefromtarkov.exe': 'Escape from Tarkov',
  'tslgame.exe': 'PUBG: Battlegrounds',
  'cod.exe': 'Call of Duty',
  'modernwarfare.exe': 'Call of Duty: Modern Warfare',
  'blackopscoldwar.exe': 'Call of Duty: Black Ops Cold War',
  'bf2042.exe': 'Battlefield 2042',
  'bf6.exe': 'Battlefield 6',
  'bfv.exe': 'Battlefield V',
  'bf1.exe': 'Battlefield 1',
  'destiny2.exe': 'Destiny 2',
  'discovery.exe': 'THE FINALS',
  'marvel-win64-shipping.exe': 'Marvel Rivals',
  'deltaforceclient-win64-shipping.exe': 'Delta Force',
  'titanfall2.exe': 'Titanfall 2',
  'haloinfinite.exe': 'Halo Infinite',
  'mcc-win64-shipping.exe': 'Halo: The Master Chief Collection',
  'huntgame.exe': 'Hunt: Showdown 1896',
  'squadgame.exe': 'Squad',
  'insurgencyclient-win64-shipping.exe': 'Insurgency: Sandstorm',
  'readyornot-win64-shipping.exe': 'Ready or Not',
  'hll-win64-shipping.exe': 'Hell Let Loose',
  'enlisted.exe': 'Enlisted',
  'battlebit.exe': 'BattleBit Remastered',
  'paladins.exe': 'Paladins',
  'tf_win64.exe': 'Team Fortress 2',
  'left4dead2.exe': 'Left 4 Dead 2',
  'back4blood.exe': 'Back 4 Blood',
  'payday3client-win64-shipping.exe': 'PAYDAY 3',
  'gtfo.exe': 'GTFO',
  'darktide.exe': 'Warhammer 40,000: Darktide',
  'vermintide2.exe': 'Warhammer: Vermintide 2',
  'fsd-win64-shipping.exe': 'Deep Rock Galactic',
  'helldivers2.exe': 'HELLDIVERS 2',
  'remnant2.exe': 'Remnant II',
  'borderlands3.exe': 'Borderlands 3',
  'borderlands4.exe': 'Borderlands 4',
  'starwarsbattlefrontii.exe': 'Star Wars Battlefront II',
  'pavlov-win64-shipping.exe': 'Pavlov VR',
  'hlvr.exe': 'Half-Life: Alyx',
  'gmod.exe': "Garry's Mod",
  'project8.exe': 'Deadlock',
  'warframe.x64.exe': 'Warframe',
  // MOBA, strategie
  'dota2.exe': 'Dota 2',
  'league of legends.exe': 'League of Legends',
  'smite.exe': 'SMITE',
  'heroesofthestorm_x64.exe': 'Heroes of the Storm',
  'sc2_x64.exe': 'StarCraft II',
  'warcraft iii.exe': 'Warcraft III: Reforged',
  'stormgate.exe': 'Stormgate',
  'reliccardinal.exe': 'Age of Empires IV',
  'aoe2de_s.exe': 'Age of Empires II: Definitive Edition',
  'reliccoh3.exe': 'Company of Heroes 3',
  'warhammer3.exe': 'Total War: WARHAMMER III',
  'civilizationvi.exe': "Sid Meier's Civilization VI",
  'civilizationvii.exe': "Sid Meier's Civilization VII",
  'ck3.exe': 'Crusader Kings III',
  'eu4.exe': 'Europa Universalis IV',
  'hoi4.exe': 'Hearts of Iron IV',
  'stellaris.exe': 'Stellaris',
  'victoria3.exe': 'Victoria 3',
  'cities2.exe': 'Cities: Skylines II',
  'cities.exe': 'Cities: Skylines',
  'anno1800.exe': 'Anno 1800',
  'anno117.exe': 'Anno 117: Pax Romana',
  'manorlords-win64-shipping.exe': 'Manor Lords',
  'frostpunk2.exe': 'Frostpunk 2',
  'bannerlord.exe': 'Mount & Blade II: Bannerlord',
  // sandbox, survival, co-op
  'minecraft.windows.exe': 'Minecraft',
  'javaw.exe': 'Minecraft',
  'java.exe': 'Minecraft',
  'robloxplayerbeta.exe': 'Roblox',
  'rustclient.exe': 'Rust',
  'terraria.exe': 'Terraria',
  'starbound.exe': 'Starbound',
  'valheim.exe': 'Valheim',
  'palworld-win64-shipping.exe': 'Palworld',
  'enshrouded.exe': 'Enshrouded',
  'vrising.exe': 'V Rising',
  'sonsoftheforest.exe': 'Sons of the Forest',
  'theforest.exe': 'The Forest',
  'raft.exe': 'Raft',
  'grounded.exe': 'Grounded',
  'subnautica.exe': 'Subnautica',
  'shootergame.exe': 'ARK: Survival Evolved',
  'arkascended.exe': 'ARK: Survival Ascended',
  'conansandbox.exe': 'Conan Exiles',
  'dayz_x64.exe': 'DayZ',
  'scum.exe': 'SCUM',
  'unturned.exe': 'Unturned',
  '7daystodie.exe': '7 Days to Die',
  'projectzomboid64.exe': 'Project Zomboid',
  'dontstarve_steam_x64.exe': "Don't Starve Together",
  'corekeeper.exe': 'Core Keeper',
  'lethal company.exe': 'Lethal Company',
  'content warning.exe': 'Content Warning',
  'repo.exe': 'R.E.P.O.',
  'peak.exe': 'PEAK',
  'schedule i.exe': 'Schedule I',
  'phasmophobia.exe': 'Phasmophobia',
  'devour.exe': 'DEVOUR',
  'pacify.exe': 'Pacify',
  'deadbydaylight-win64-shipping.exe': 'Dead by Daylight',
  'amongus.exe': 'Among Us',
  'fallguys_client_game.exe': 'Fall Guys',
  'pummelparty.exe': 'Pummel Party',
  'gang beasts.exe': 'Gang Beasts',
  'human.exe': 'Human: Fall Flat',
  'overcooked2.exe': 'Overcooked! 2',
  'stickfight.exe': 'Stick Fight: The Game',
  'partyanimals.exe': 'Party Animals',
  'golf with your friends.exe': 'Golf With Your Friends',
  'golf it.exe': 'Golf It!',
  'seaofthieves.exe': 'Sea of Thieves',
  'spaceengineers.exe': 'Space Engineers',
  'stormworks64.exe': 'Stormworks',
  'teardown.exe': 'Teardown',
  'scrapmechanic.exe': 'Scrap Mechanic',
  'astro-win64-shipping.exe': 'ASTRONEER',
  'factorygame-win64-shipping.exe': 'Satisfactory',
  'factorio.exe': 'Factorio',
  'rimworldwin64.exe': 'RimWorld',
  'ksp_x64.exe': 'Kerbal Space Program',
  'vrchat.exe': 'VRChat',
  'gorilla tag.exe': 'Gorilla Tag',
  'beat saber.exe': 'Beat Saber',
  'bladeandsorcery.exe': 'Blade & Sorcery',
  'bonelab_steam_windows64.exe': 'BONELAB',
  // závody, simulátory, sport
  'rocketleague.exe': 'Rocket League',
  'forzahorizon5.exe': 'Forza Horizon 5',
  'forzamotorsport.exe': 'Forza Motorsport',
  'needforspeedunbound.exe': 'Need for Speed Unbound',
  'needforspeedheat.exe': 'Need for Speed Heat',
  'thecrewmotorfest.exe': 'The Crew Motorfest',
  'beamng.drive.x64.exe': 'BeamNG.drive',
  'wreckfest_x64.exe': 'Wreckfest',
  'trackmania.exe': 'Trackmania',
  'acs.exe': 'Assetto Corsa',
  'ac2-win64-shipping.exe': 'Assetto Corsa Competizione',
  'iracingsim64dx11.exe': 'iRacing',
  'rfactor2.exe': 'rFactor 2',
  'dirtrally2.exe': 'DiRT Rally 2.0',
  'wrc.exe': 'EA SPORTS WRC',
  'f1_25.exe': 'F1 25',
  'f1_24.exe': 'F1 24',
  'eurotrucks2.exe': 'Euro Truck Simulator 2',
  'amtrucks.exe': 'American Truck Simulator',
  'farmingsimulator2025game.exe': 'Farming Simulator 25',
  'farmingsimulator2022game.exe': 'Farming Simulator 22',
  'snowrunner.exe': 'SnowRunner',
  'flightsimulator.exe': 'Microsoft Flight Simulator',
  'flightsimulator2024.exe': 'Microsoft Flight Simulator 2024',
  'dcs.exe': 'DCS World',
  'aces.exe': 'War Thunder',
  'worldoftanks.exe': 'World of Tanks',
  'arma3_x64.exe': 'Arma 3',
  'armareforgersteam.exe': 'Arma Reforger',
  'elitedangerous64.exe': 'Elite Dangerous',
  'starcitizen.exe': 'Star Citizen',
  'powerwashsimulator.exe': 'PowerWash Simulator',
  'supermarket simulator.exe': 'Supermarket Simulator',
  'fc26.exe': 'EA SPORTS FC 26',
  'fc25.exe': 'EA SPORTS FC 25',
  'fc24.exe': 'EA SPORTS FC 24',
  'nba2k26.exe': 'NBA 2K26',
  'nba2k25.exe': 'NBA 2K25',
  'wwe2k25.exe': 'WWE 2K25',
  // RPG, akce, adventury
  'gta5.exe': 'Grand Theft Auto V',
  'gta5_enhanced.exe': 'Grand Theft Auto V',
  'fivem_gtaprocess.exe': 'FiveM',
  'rdr2.exe': 'Red Dead Redemption 2',
  'cyberpunk2077.exe': 'Cyberpunk 2077',
  'witcher3.exe': 'The Witcher 3: Wild Hunt',
  'kingdomcome.exe': 'Kingdom Come: Deliverance',
  'eldenring.exe': 'ELDEN RING',
  'nightreign.exe': 'ELDEN RING NIGHTREIGN',
  'sekiro.exe': 'Sekiro: Shadows Die Twice',
  'darksoulsiii.exe': 'DARK SOULS III',
  'armoredcore6.exe': 'ARMORED CORE VI',
  'lop-win64-shipping.exe': 'Lies of P',
  'b1-win64-shipping.exe': 'Black Myth: Wukong',
  'hogwartslegacy.exe': 'Hogwarts Legacy',
  'starfield.exe': 'Starfield',
  'fallout4.exe': 'Fallout 4',
  'skyrimse.exe': 'The Elder Scrolls V: Skyrim',
  'oblivionremastered-win64-shipping.exe': 'The Elder Scrolls IV: Oblivion Remastered',
  'bg3.exe': "Baldur's Gate 3",
  'bg3_dx11.exe': "Baldur's Gate 3",
  'eocapp.exe': 'Divinity: Original Sin 2',
  'avowed.exe': 'Avowed',
  'disco.exe': 'Disco Elysium',
  'diablo iv.exe': 'Diablo IV',
  'wow.exe': 'World of Warcraft',
  'hearthstone.exe': 'Hearthstone',
  'pathofexile.exe': 'Path of Exile',
  'pathofexile_x64.exe': 'Path of Exile',
  'pathofexilesteam.exe': 'Path of Exile',
  'last epoch.exe': 'Last Epoch',
  'grim dawn.exe': 'Grim Dawn',
  'lostark.exe': 'Lost Ark',
  'blackdesert64.exe': 'Black Desert',
  'albion-online.exe': 'Albion Online',
  'newworld.exe': 'New World: Aeternum',
  'ffxiv_dx11.exe': 'FINAL FANTASY XIV',
  'ffxvi.exe': 'FINAL FANTASY XVI',
  'gw2-64.exe': 'Guild Wars 2',
  'eso64.exe': 'The Elder Scrolls Online',
  'rs2client.exe': 'RuneScape',
  'osclient.exe': 'Old School RuneScape',
  'genshinimpact.exe': 'Genshin Impact',
  'starrail.exe': 'Honkai: Star Rail',
  'zenlesszonezero.exe': 'Zenless Zone Zero',
  'monsterhunterwilds.exe': 'Monster Hunter Wilds',
  'monsterhunterworld.exe': 'Monster Hunter: World',
  'monsterhunterrise.exe': 'Monster Hunter Rise',
  'dd2.exe': "Dragon's Dogma 2",
  're4.exe': 'Resident Evil 4',
  're8.exe': 'Resident Evil Village',
  're2.exe': 'Resident Evil 2',
  're3.exe': 'Resident Evil 3',
  'shproto-win64-shipping.exe': 'SILENT HILL 2',
  'alanwake2.exe': 'Alan Wake 2',
  'control_dx12.exe': 'Control',
  'control_dx11.exe': 'Control',
  'dead space.exe': 'Dead Space',
  'stalker2-win64-shipping.exe': 'S.T.A.L.K.E.R. 2: Heart of Chornobyl',
  'metroexodus.exe': 'Metro Exodus',
  'dyinglightgame_x64_rwdi.exe': 'Dying Light 2',
  'deadisland-win64-shipping.exe': 'Dead Island 2',
  'gow.exe': 'God of War',
  'gowr.exe': 'God of War Ragnarök',
  'spider-man.exe': "Marvel's Spider-Man Remastered",
  'spider-man2.exe': "Marvel's Spider-Man 2",
  'horizonzerodawn.exe': 'Horizon Zero Dawn',
  'horizonforbiddenwest.exe': 'Horizon Forbidden West',
  'tlou-i.exe': 'The Last of Us Part I',
  'tlou-ii.exe': 'The Last of Us Part II',
  'ghostoftsushima.exe': 'Ghost of Tsushima',
  'acshadows.exe': "Assassin's Creed Shadows",
  'acvalhalla.exe': "Assassin's Creed Valhalla",
  'acmirage.exe': "Assassin's Creed Mirage",
  'farcry6.exe': 'Far Cry 6',
  'thedivision2.exe': "Tom Clancy's The Division 2",
  'forhonor.exe': 'For Honor',
  'outlaws.exe': 'Star Wars Outlaws',
  'jedisurvivor.exe': 'Star Wars Jedi: Survivor',
  'sifu.exe': 'Sifu',
  'chivalry2-win64-shipping.exe': 'Chivalry 2',
  'mordhau-win64-shipping.exe': 'MORDHAU',
  'p5r.exe': 'Persona 5 Royal',
  'p3r.exe': 'Persona 3 Reload',
  'metaphor.exe': 'Metaphor: ReFantazio',
  'splitfiction.exe': 'Split Fiction',
  'ts4_x64.exe': 'The Sims 4',
  // bojovky, karty, rytmus, indie
  'polaris-win64-shipping.exe': 'TEKKEN 8',
  'streetfighter6.exe': 'Street Fighter 6',
  'mk12.exe': 'Mortal Kombat 1',
  'ggst-win64-shipping.exe': 'GUILTY GEAR -STRIVE-',
  'brawlhalla.exe': 'Brawlhalla',
  'multiversus.exe': 'MultiVersus',
  'lor.exe': 'Legends of Runeterra',
  'mtga.exe': 'Magic: The Gathering Arena',
  'masterduel.exe': 'Yu-Gi-Oh! Master Duel',
  'osu!.exe': 'osu!',
  'geometrydash.exe': 'Geometry Dash',
  'undertale.exe': 'Undertale',
  'deltarune.exe': 'DELTARUNE',
  'cuphead.exe': 'Cuphead',
  'hollow_knight.exe': 'Hollow Knight',
  'hollow knight silksong.exe': 'Hollow Knight: Silksong',
  'celeste.exe': 'Celeste',
  'oriwotw.exe': 'Ori and the Will of the Wisps',
  'deadcells.exe': 'Dead Cells',
  'hades.exe': 'Hades',
  'hades2.exe': 'Hades II',
  'slaythespire.exe': 'Slay the Spire',
  'balatro.exe': 'Balatro',
  'vampiresurvivors.exe': 'Vampire Survivors',
  'brotato.exe': 'Brotato',
  'risk of rain 2.exe': 'Risk of Rain 2',
  'etg.exe': 'Enter the Gungeon',
  'isaac-ng.exe': 'The Binding of Isaac: Rebirth',
  'stardew valley.exe': 'Stardew Valley',
  'outerwilds.exe': 'Outer Wilds',
  'nms.exe': "No Man's Sky",
  'buckshot roulette.exe': 'Buckshot Roulette',
};
