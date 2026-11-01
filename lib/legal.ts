/**
 * Pravidla komunity, Podmínky používání a Ochrana osobních údajů - texty
 * v češtině a angličtině (components/LegalDoc.tsx ukazuje češtinu tomu,
 * kdo má Kine česky nebo slovensky, ostatním angličtinu; jde přepnout).
 *
 * Podmínky a Pravidla jsou psané jako právní dokument (číslované články
 * a odstavce, české právo, spotřebitelské právo, nařízení EU o digitálních
 * službách - DSA, GDPR), ale srozumitelně; nahoře mají „Ve zkratce“.
 * Zásada od provozovatele: co největší svoboda projevu a svoboda tvůrců -
 * zakazuje se jen nezákonné jednání a to, co skutečně ubližuje konkrétním
 * lidem; žádné porno (umělecká nahota ano).
 *
 * Píše se podle toho, co Kine opravdu dělá (živé vysílání, Kine Plus,
 * platby tvůrcům přes Stripe, Kine Clipper, automatická kontrola obsahu).
 * Kontakt je jen kinesupport@gmail.com. Provozovatel (jméno, IČO, místo
 * podnikání) se doplní z Vercelu - lib/operator.ts. Nejsem právník - před
 * větším růstem stojí za to nechat dokumenty projít advokátem.
 */

import { operatorLine } from './operator';

export type LegalSection = { heading: string; paragraphs?: string[]; items?: string[] };
export type LegalDocText = {
  title: string;
  intro: string[];
  /** „Ve zkratce“ nahoře - jen pro orientaci, závazný je celý text. */
  summary?: string[];
  /** Číslované články (1., 2.…) a odstavce (1.1, 1.2…). */
  numbered?: boolean;
  sections: LegalSection[];
  footer: string;
};
export type LegalDoc = { cs: LegalDocText; en: LegalDocText };

export const LEGAL_CONTACT = 'kinesupport@gmail.com';
/** Pravidla komunity: účinnost posledního znění. */
export const RULES_UPDATED = { cs: '30. října 2026', en: '30 October 2026' };
/** Starší název (dřívější importy). */
export const LEGAL_UPDATED = RULES_UPDATED;
/** Podmínky a ochrana údajů: účinnost posledního znění. */
export const TERMS_UPDATED = { cs: '30. října 2026', en: '30 October 2026' };
/** Ochrana osobních údajů: ankety v chatu, připomenutí vysílání, klipy z vysílání, raidy (0137). */
export const PRIVACY_UPDATED = { cs: '1. listopadu 2026', en: '1 November 2026' };

const OPERATOR_CS = operatorLine('cs');
const OPERATOR_EN = operatorLine('en');

// ============================================================================
// PRAVIDLA KOMUNITY
// ============================================================================

export const RULES: LegalDoc = {
  cs: {
    title: `Pravidla komunity Kine`,
    numbered: true,
    intro: [
      `Kine stojí na svobodě projevu a na svobodě tvůrců. Chceme, aby tu každý mohl říct, co si myslí - včetně názorů, se kterými nesouhlasíme, kontroverzních témat, ostré satiry a černého humoru. Tato pravidla proto nezakazují názory, ale jednání, které je nezákonné nebo skutečně ubližuje konkrétním lidem.`,
      `Pravidla platí pro veškerý obsah na Kine - videa, Sparks, živá vysílání, klipy, náhledy, názvy a popisy, titulky, příspěvky, ankety, komentáře, zprávy v chatu, vzkazy u podpor a Super díky, profilové fotky, bannery i uživatelská jména. Jsou nedílnou součástí Podmínek používání (/terms).`,
    ],
    summary: [
      `Názory, satira, kritika a kontroverzní témata sem patří - s nesouhlasem naložíš hodnocením, ne nahlášením.`,
      `Zakázané je to, co je nezákonné nebo ubližuje konkrétním lidem: zneužívání dětí, výhrůžky, cílené obtěžování, zveřejňování cizích údajů, podvody.`,
      `Žádná pornografie ani sexuální obsah. Umělecká, vzdělávací a dokumentární nahota je v pořádku.`,
      `Nahrávej jen to, k čemu máš práva, a placenou spolupráci vždy označ.`,
      `Za porušení zasahujeme přiměřeně - od skrytí obsahu po zrušení účtu. Vždy řekneme proč a můžeš se odvolat.`,
    ],
    sections: [
      {
        heading: `Naše zásady`,
        items: [
          `Svoboda projevu. Obsah neodstraňujeme jen proto, že je nepopulární, někoho uráží, je provokativní nebo je v rozporu s názorem většiny či provozovatele.`,
          `Rozhoduje kontext. Stejný záběr může být v pořádku ve zpravodajství, dokumentu, vzdělávacím videu, umění nebo satiře a nepřijatelný jako oslava nebo návod. Posuzujeme vždy celek, účel a pravděpodobný dopad.`,
          `Přiměřenost. Volíme nejmírnější zásah, který stačí - raději omezení dosahu nebo označení jako nevhodné pro děti než smazání, raději smazání jednoho videa než zrušení účtu.`,
          `Rovný přístup. Pravidla platí stejně pro každého bez ohledu na velikost kanálu, názory nebo vztah k provozovateli.`,
          `Svoboda tvůrců. Ve svém kanálu a chatu si tvůrci nastavují vlastní pravidla (moderace chatu, vypnutí komentářů), pokud nejsou v rozporu s těmito pravidly.`,
        ],
      },
      {
        heading: `Co je na Kine v pořádku`,
        paragraphs: [`Následující obsah je dovolený, i když se může někoho dotknout:`],
        items: [
          `kontroverzní politické, náboženské, společenské a vědecké názory a jejich kritika,`,
          `satira, parodie, karikatura, nadsázka a černý humor,`,
          `ostrá kritika veřejně známých osob, politiků, firem, institucí, náboženství a ideologií,`,
          `otevřená debata o citlivých tématech (drogy, sexualita, duševní zdraví, kriminalita) v informativním nebo osvětovém pojetí,`,
          `zpravodajský, dokumentární, vzdělávací a umělecký obsah, který zobrazuje násilí, válku nebo jiné drsné skutečnosti, pokud je zasazený do kontextu,`,
          `videohry včetně her s násilím,`,
          `sprostá slova a vulgarity - jde-li o obsah nevhodný pro děti, označ ho tak (čl. 16).`,
        ],
      },
      {
        heading: `Bezpečnost dětí (nulová tolerance)`,
        items: [
          `Zakázaný je jakýkoliv obsah, který sexuálně zneužívá, sexualizuje nebo ohrožuje děti (osoby mladší 18 let) - včetně kresleného, animovaného a uměle vytvořeného obsahu.`,
          `Zakázané je navazování kontaktu s dětmi za účelem jejich zneužití (grooming), vyžadování intimních fotografií od nezletilých a jakákoliv sexuální komunikace s nimi.`,
          `Zakázaný je obsah, ve kterém jsou děti vystavovány nebezpečí, ponižovány nebo zneužívány (například k nebezpečným výzvám), a zveřejňování osobních údajů dětí.`,
          `Za porušení okamžitě a natrvalo rušíme účet. Obsah zachycující sexuální zneužívání dětí vždy oznamujeme Policii České republiky a dalším příslušným orgánům a uchováme ho pro potřeby vyšetřování v rozsahu, který vyžaduje zákon.`,
        ],
      },
      {
        heading: `Sexuální obsah a nahota`,
        items: [
          `Zakázaná je pornografie a otevřeně sexuální obsah - zobrazení pohlavního styku a sexuálních praktik, záběry na pohlavní orgány za účelem sexuálního vzrušení a sexuální obsah v náhledech, profilových fotkách, bannerech a přenosech.`,
          `Zakázané je nabízení nebo zprostředkování sexuálních služeb a odkazy na pornografický obsah mimo Kine.`,
          `Dovolená je nahota v uměleckém díle (malba, socha, fotografie, film), ve vzdělávacím, zdravotnickém, vědeckém a dokumentárním kontextu a při kojení - pokud není pornografická a není hlavním účelem obsahu.`,
          `Náhledy, profilové fotky, bannery a přenosy kontroluje automatická detekce nahoty; obsah, u kterého ji zachytí, může být až do posouzení moderátorem skrytý.`,
        ],
      },
      {
        heading: `Intimní obsah bez souhlasu a deepfakes`,
        items: [
          `Zakázané je zveřejnit nebo vyhrožovat zveřejněním intimních fotografií či videí kohokoliv bez jeho souhlasu („revenge porn“) a vydírat intimním obsahem (sextortion).`,
          `Zakázaný je sexuální nebo ponižující uměle vytvořený či upravený obsah (deepfake), který zobrazuje skutečnou osobu bez jejího souhlasu.`,
          `Za porušení okamžitě rušíme účet. Dotčená osoba nám může takový obsah nahlásit i bez účtu na ${LEGAL_CONTACT}; vyřizujeme ho přednostně.`,
        ],
      },
      {
        heading: `Násilí, výhrůžky a teroristický obsah`,
        items: [
          `Zakázané jsou vážně míněné výhrůžky násilím vůči konkrétní osobě nebo skupině a výzvy k násilí.`,
          `Zakázané je oslavování nebo propagace teroristických útoků, hromadných vražd a jejich pachatelů způsobem, který k napodobení povzbuzuje, a teroristický obsah ve smyslu práva Evropské unie (propaganda, nábor, návody).`,
          `Zakázané je samoúčelné zobrazování skutečného krutého násilí (vraždy, mučení, týrání lidí či zvířat) pro šok nebo pobavení. Zpravodajský, dokumentární a vzdělávací obsah je dovolený - nesmí však být v náhledu a musí být označen jako nevhodný pro děti.`,
          `Zakázané jsou výzvy k lynči nebo „odvetě“ a násilí jako součást vysílání (například na přání za podporu).`,
        ],
      },
      {
        heading: `Nenávist a extremismus`,
        items: [
          `Názory na skupiny lidí, náboženství, ideologie a politiku - i tvrdé a nepopulární - jsou dovolené.`,
          `Zakázané jsou výzvy k násilí, k omezování práv nebo k nenávisti vůči skupině lidí kvůli jejich národnosti, etnickému původu, rase, náboženství, pohlaví, sexuální orientaci, zdravotnímu postižení nebo jinému obdobnému znaku, pokud takové jednání porušuje zákon.`,
          `Zakázaná je propagace hnutí, která směřují k potlačení práv a svobod člověka (například nacismus), včetně jejich symbolů použitých k propagaci. Historický, vzdělávací, zpravodajský a umělecký obsah je dovolený.`,
          `Zakázané je veřejné popírání, zpochybňování, schvalování nebo ospravedlňování genocidy a zločinů proti lidskosti v rozsahu, v jakém je to trestné.`,
        ],
      },
      {
        heading: `Obtěžování a šikana`,
        items: [
          `Zakázané je opakované cílené obtěžování nebo zastrašování konkrétního člověka, včetně obsahu, jehož hlavním účelem je ponížit nebo zesměšnit soukromou osobu.`,
          `Zakázané je podněcovat ostatní k obtěžování (organizované nájezdy do komentářů nebo chatu jiného tvůrce).`,
          `Zakázané je sexuální obtěžování - nevyžádané sexuální návrhy, komentáře k tělu a zasílání sexuálního obsahu.`,
          `Kritika veřejně známých osob a jejich práce obtěžováním není, pokud nepřechází ve výhrůžky nebo zveřejňování soukromých údajů.`,
        ],
      },
      {
        heading: `Soukromí a osobní údaje`,
        items: [
          `Zakázané je zveřejňovat cizí osobní údaje bez souhlasu - adresu, telefon, doklady, přihlašovací údaje, zdravotní nebo finanční informace (doxxing), a to ani „z legrace“.`,
          `Zakázané je natáčet nebo zveřejňovat lidi bez jejich vědomí v soukromí (domov, toalety, šatny) a zveřejňovat soukromou komunikaci s cílem někomu uškodit.`,
          `Vystupuje-li ve tvém obsahu rozpoznatelný člověk, potřebuješ jeho souhlas, nejde-li o zpravodajství, veřejné dění nebo jinou výjimku, kterou dovoluje zákon. Na odůvodněnou žádost dotčené osoby takový obsah upravíme nebo odstraníme.`,
        ],
      },
      {
        heading: `Sebepoškozování a nebezpečné činnosti`,
        items: [
          `Zakázaný je obsah, který propaguje, oslavuje nebo návodně popisuje sebevraždu, sebepoškozování nebo poruchy příjmu potravy.`,
          `Zakázané jsou nebezpečné výzvy a kousky, u kterých hrozí vážné zranění, zejména pokud povzbuzují k napodobení.`,
          `Dovolený je osvětový, preventivní a podpůrný obsah a sdílení vlastní zkušenosti s uzdravením - bez podrobných popisů metod.`,
          `Je-li někdo v bezprostředním ohrožení, volej 112. Pokud se necítíš dobře ty, v Česku je nonstop a zdarma Linka první psychické pomoci 116 123 a pro děti a mladé Linka bezpečí 116 111.`,
        ],
      },
      {
        heading: `Nelegální a regulované zboží a činnosti`,
        items: [
          `Zakázaný je prodej nebo zprostředkování drog, zbraní, střeliva, výbušnin, padělků, kradených věcí, dat a účtů, falešných dokladů a jiného zboží či služeb, jejichž prodej je nezákonný.`,
          `Zakázané jsou návody k výrobě zbraní a výbušnin, k páchání trestné činnosti a k neoprávněnému průniku do cizích systémů; legální bezpečnostní výzkum a vzdělávání bez návodu ke zneužití jsou dovolené.`,
          `Zakázaná je propagace hazardních her a sázek provozovatelů bez licence, obchodování s lidmi a nabídky „práce“, které jsou ve skutečnosti podvodem nebo vykořisťováním.`,
          `Zpravodajský, dokumentární a vzdělávací obsah o těchto tématech je dovolený.`,
        ],
      },
      {
        heading: `Podvody, spam a klamání`,
        items: [
          `Zakázané jsou podvody a klamavé praktiky - phishing, falešné soutěže a „rozdávačky“, podvodné investice, pyramidové hry, falešné sbírky a odkazy na škodlivý software.`,
          `Zakázané je vydávat se za jinou osobu, značku, organizaci nebo za tým Kine a klamavě předstírat oficiální spojení s nimi. Parodie je dovolená, pokud je jako parodie jasně rozpoznatelná.`,
          `Zakázaný je spam - hromadné opakování stejného obsahu, nevyžádaná reklama v komentářích a chatu a klamavé názvy, popisy nebo náhledy, které s obsahem nesouvisejí.`,
        ],
      },
      {
        heading: `Manipulace s Kine`,
        items: [
          `Zakázané je uměle zvyšovat čísla - kupovat nebo prodávat zhlédnutí, odběry, hodnocení a komentáře a používat k tomu roboty, skripty nebo síť účtů.`,
          `Zakázané je používat více účtů k obcházení omezení a zákazů nebo k ovlivňování hodnocení a doporučování.`,
          `Zakázané je zneužívat nahlašování k umlčování názorů nebo k obtěžování; vědomě nepravdivá oznámení jsou porušením pravidel.`,
        ],
      },
      {
        heading: `Autorská práva a duševní vlastnictví`,
        items: [
          `Nahrávej jen obsah, ke kterému máš práva - vlastní tvorbu, licencovaný obsah nebo užití, které dovoluje zákon (například citaci, parodii nebo zpravodajství).`,
          `Kdo se domnívá, že někdo užil jeho dílo bez svolení, může podat oznámení formulářem na stránce Autorská práva (/copyright) - účet k tomu nepotřebuje. Oznámení posoudí moderátor; je-li oprávněné, obsah znepřístupníme a nahrávající se dozví proč a může se bránit.`,
          `Opakované porušování autorských práv vede k omezení a nakonec ke zrušení účtu.`,
          `Zakázané je užívat cizí ochranné známky a loga způsobem, který klame o původu obsahu nebo o spojení s jejich vlastníkem.`,
        ],
      },
      {
        heading: `Reklama, sponzoring a obsah vytvořený umělou inteligencí`,
        items: [
          `Placenou spolupráci (sponzoring, umístění produktu, affiliate odkazy, zboží zdarma výměnou za recenzi) musíš ve videu nebo v popisu jasně označit.`,
          `Nepropaguj zboží a služby, jejichž reklama je zakázaná nebo omezená (například hazard bez licence, tabákové a alkoholové výrobky cílené na děti, léky na předpis).`,
          `Realisticky působící obsah vytvořený nebo upravený umělou inteligencí, který zobrazuje skutečné osoby, místa nebo události, označ v názvu nebo popisu, aby nikoho neuvedl v omyl. Zjevnou nadsázku, fantasy a umělecké úpravy označovat nemusíš.`,
        ],
      },
      {
        heading: `Vhodnost pro děti`,
        items: [
          `Při nahrávání uvádíš, zda je obsah vhodný pro děti. Obsah s vulgaritami, drsným násilím, děsivými scénami nebo tématy pro dospělé označ jako nevhodný pro děti.`,
          `Obsah určený dětem nesmí obsahovat nic nevhodného a nesmí je navádět k nebezpečnému jednání.`,
          `Kine není určeno dětem mladším 13 let (Podmínky používání, čl. 2).`,
        ],
      },
      {
        heading: `Živé vysílání a chat`,
        items: [
          `Pro vysílání platí stejná pravidla jako pro videa. Nevysílej trestnou činnost ani skutečné ohrožení života nebo zdraví.`,
          `Automatická kontrola může přenos, ve kterém zachytí nahotu, dočasně skrýt, než ho posoudí moderátor; při vážném porušení vysílání ukončíme.`,
          `Ve svém chatu můžeš mazat zprávy, ztlumit a zablokovat uživatele, zapnout pomalý režim a jmenovat moderátory. Používej to - za atmosféru ve svém vysílání máš kus odpovědnosti i ty.`,
          `Nezneužívej čtení zpráv nahlas ani jiné funkce chatu k obtěžování.`,
        ],
      },
      {
        heading: `Peníze od diváků`,
        items: [
          `Podpory ve vysílání a Super díky pod videi jsou dobrovolné dary. Nevymáhej je, neslibuj za ně nic, co nesplníš, a nepoužívej je k obcházení pravidel.`,
          `Zakázané jsou falešné sbírky, losování a hry o peníze za podpory (loterie bez povolení) a výzvy k nebezpečnému nebo nezákonnému jednání za peníze.`,
          `Výhody předplatného kanálu musí odpovídat tomu, co slibuješ. Vzkazy u plateb musí dodržovat tato pravidla - jinak je skryjeme.`,
          `Při vážném nebo opakovaném porušení můžeme pozastavit příjem peněz a výplaty (Podmínky používání, čl. 10).`,
        ],
      },
      {
        heading: `Jak pravidla vymáháme`,
        items: [
          `Obsah posuzujeme na základě oznámení uživatelů i dalších osob, automatických kontrol (zejména detekce nahoty a ochrany před spamem) a práce moderátorů. Automatika obsah nanejvýš dočasně skryje; o trvalém odstranění obsahu a o zrušení účtu rozhoduje člověk.`,
          `Podle závažnosti, úmyslu a předchozích porušení můžeme: upozornit, skrýt nebo odstranit obsah, omezit jeho dosah (nedoporučovat ho), označit ho jako nevhodný pro děti, omezit funkce účtu (nahrávání, vysílání, komentáře, chat), pozastavit příjem peněz a výplaty, dočasně zablokovat účet nebo ho zrušit.`,
          `Vážná porušení (čl. 3 a 5, vážně míněné výhrůžky, teroristický obsah, zveřejnění cizích osobních údajů) vedou k okamžitému zrušení účtu a mohou být oznámena orgánům činným v trestním řízení.`,
          `O každém zásahu do tvého obsahu nebo účtu tě informujeme s odůvodněním - co jsme udělali, proč a podle kterého pravidla - a s poučením, jak se odvolat (Podmínky používání, čl. 8).`,
          `Zrušení účtu nesmíš obcházet založením nového.`,
        ],
      },
      {
        heading: `Jak nahlásit porušení`,
        items: [
          `Použij tlačítko Nahlásit u videa, komentáře, příspěvku, profilu nebo zprávy v chatu.`,
          `Porušení autorských práv nahlas formulářem na stránce /copyright.`,
          `Bez účtu nebo u nezákonného obsahu napiš na ${LEGAL_CONTACT}: odkaz na obsah, proč je podle tebe nezákonný nebo porušuje pravidla, své jméno a e-mail a prohlášení, že údaje uvádíš v dobré víře a podle svého nejlepšího vědomí. U obsahu zneužívajícího děti nemusíš uvádět své jméno.`,
          `Při bezprostředním ohrožení života nebo zdraví volej nejdřív 112.`,
        ],
      },
    ],
    footer: `Pravidla budeme časem upravovat; o podstatných změnách dáme vědět předem. Používáním Kine s nimi souhlasíš. Účinnost od ${RULES_UPDATED.cs}.`,
  },
  en: {
    title: `Kine Community Guidelines`,
    numbered: true,
    intro: [
      `Kine is built on freedom of expression and freedom for creators. We want everyone to be able to say what they think - including opinions we disagree with, controversial topics, sharp satire and dark humour. These guidelines therefore do not prohibit opinions; they prohibit conduct that is illegal or genuinely harms specific people.`,
      `The guidelines apply to all content on Kine - videos, Sparks, live streams, clips, thumbnails, titles and descriptions, captions, posts, polls, comments, chat messages, messages attached to tips and Super Thanks, profile pictures, banners and usernames. They form an integral part of the Terms of Service (/terms).`,
    ],
    summary: [
      `Opinions, satire, criticism and controversial topics belong here - deal with disagreement by rating, not by reporting.`,
      `What is prohibited is what is illegal or harms specific people: child abuse, threats, targeted harassment, publishing other people's personal data, scams.`,
      `No pornography or sexual content. Artistic, educational and documentary nudity is fine.`,
      `Only upload what you have the rights to, and always label paid promotions.`,
      `We respond to violations proportionately - from hiding content to closing the account. We always tell you why, and you can appeal.`,
    ],
    sections: [
      {
        heading: `Our principles`,
        items: [
          `Freedom of expression. We do not remove content merely because it is unpopular, offends someone, is provocative, or contradicts the views of the majority or of the operator.`,
          `Context matters. The same footage may be acceptable in news, a documentary, an educational video, art or satire, and unacceptable as glorification or instructions. We always assess the whole, its purpose and its likely impact.`,
          `Proportionality. We choose the mildest measure that is sufficient - limiting reach or marking content as unsuitable for children rather than removing it, removing one video rather than closing the account.`,
          `Equal treatment. The guidelines apply equally to everyone, regardless of channel size, opinions or relationship with the operator.`,
          `Creator freedom. In their own channel and chat, creators set their own rules (chat moderation, turning comments off), as long as they do not conflict with these guidelines.`,
        ],
      },
      {
        heading: `What is fine on Kine`,
        paragraphs: [`The following content is allowed, even if it may offend someone:`],
        items: [
          `controversial political, religious, social and scientific opinions and criticism of them,`,
          `satire, parody, caricature, exaggeration and dark humour,`,
          `sharp criticism of public figures, politicians, companies, institutions, religions and ideologies,`,
          `open discussion of sensitive topics (drugs, sexuality, mental health, crime) in an informative or educational way,`,
          `news, documentary, educational and artistic content depicting violence, war or other harsh realities, provided it is placed in context,`,
          `video games, including games with violence,`,
          `swearing and profanity - if the content is not suitable for children, mark it accordingly (section 16).`,
        ],
      },
      {
        heading: `Child safety (zero tolerance)`,
        items: [
          `Any content that sexually exploits, sexualises or endangers children (persons under 18) is prohibited - including drawn, animated and artificially generated content.`,
          `Contacting children for the purpose of abusing them (grooming), requesting intimate images from minors and any sexual communication with them are prohibited.`,
          `Content in which children are exposed to danger, humiliated or exploited (for example for dangerous challenges), and publishing children's personal data, are prohibited.`,
          `Violations lead to immediate and permanent account termination. We always report content depicting child sexual abuse to the Police of the Czech Republic and other competent authorities and preserve it for investigation to the extent required by law.`,
        ],
      },
      {
        heading: `Sexual content and nudity`,
        items: [
          `Pornography and sexually explicit content are prohibited - depictions of sexual intercourse and sexual practices, shots of genitals intended for sexual arousal, and sexual content in thumbnails, profile pictures, banners and streams.`,
          `Offering or arranging sexual services and linking to pornographic content outside Kine are prohibited.`,
          `Nudity is allowed in works of art (painting, sculpture, photography, film), in educational, medical, scientific and documentary contexts and when breastfeeding - provided it is not pornographic and is not the main purpose of the content.`,
          `Thumbnails, profile pictures, banners and streams are checked by automated nudity detection; content in which it detects nudity may be hidden until a moderator reviews it.`,
        ],
      },
      {
        heading: `Non-consensual intimate content and deepfakes`,
        items: [
          `Publishing, or threatening to publish, intimate photos or videos of anyone without their consent ("revenge porn") and blackmail with intimate content (sextortion) are prohibited.`,
          `Sexual or degrading artificially generated or manipulated content (deepfakes) depicting a real person without their consent is prohibited.`,
          `Violations lead to immediate account termination. The person concerned can report such content to us even without an account at ${LEGAL_CONTACT}; we handle these reports with priority.`,
        ],
      },
      {
        heading: `Violence, threats and terrorist content`,
        items: [
          `Credible threats of violence against a specific person or group and calls for violence are prohibited.`,
          `Glorifying or promoting terrorist attacks, mass murders and their perpetrators in a way that encourages imitation, and terrorist content within the meaning of European Union law (propaganda, recruitment, instructions), are prohibited.`,
          `Gratuitously showing real, cruel violence (killings, torture, cruelty to people or animals) for shock or entertainment is prohibited. News, documentary and educational content is allowed - but it must not appear in the thumbnail and must be marked as unsuitable for children.`,
          `Calls for lynching or "revenge" and violence as part of a stream (for example on request in exchange for a tip) are prohibited.`,
        ],
      },
      {
        heading: `Hate and extremism`,
        items: [
          `Opinions about groups of people, religions, ideologies and politics - even harsh and unpopular ones - are allowed.`,
          `Calls for violence, for restricting rights or for hatred against a group of people because of their nationality, ethnic origin, race, religion, sex, sexual orientation, disability or another similar characteristic are prohibited where such conduct breaks the law.`,
          `Promoting movements aimed at suppressing human rights and freedoms (for example Nazism), including their symbols used for promotion, is prohibited. Historical, educational, news and artistic content is allowed.`,
          `Publicly denying, questioning, approving of or justifying genocide and crimes against humanity is prohibited to the extent that it is a criminal offence.`,
        ],
      },
      {
        heading: `Harassment and bullying`,
        items: [
          `Repeated targeted harassment or intimidation of a specific person is prohibited, including content whose main purpose is to humiliate or ridicule a private individual.`,
          `Inciting others to harass (organised raids on another creator's comments or chat) is prohibited.`,
          `Sexual harassment - unwanted sexual advances, comments about someone's body and sending sexual content - is prohibited.`,
          `Criticism of public figures and their work is not harassment, as long as it does not turn into threats or the publication of private data.`,
        ],
      },
      {
        heading: `Privacy and personal data`,
        items: [
          `Publishing other people's personal data without consent - address, phone number, identity documents, login details, health or financial information (doxxing) - is prohibited, even "as a joke".`,
          `Filming or publishing people without their knowledge in private settings (homes, toilets, changing rooms) and publishing private communications in order to harm someone are prohibited.`,
          `If an identifiable person appears in your content, you need their consent unless it is news reporting, a public event or another exception permitted by law. At the justified request of the person concerned, we will edit or remove such content.`,
        ],
      },
      {
        heading: `Self-harm and dangerous activities`,
        items: [
          `Content that promotes, glorifies or gives instructions for suicide, self-harm or eating disorders is prohibited.`,
          `Dangerous challenges and stunts that risk serious injury are prohibited, especially where they encourage imitation.`,
          `Awareness, prevention and support content and sharing personal recovery experiences are allowed - without detailed descriptions of methods.`,
          `If someone is in immediate danger, call 112. If you are not feeling well yourself, contact a crisis line in your country - in the Czech Republic the free 24/7 crisis line is 116 123 and the line for children and young people is 116 111.`,
        ],
      },
      {
        heading: `Illegal and regulated goods and activities`,
        items: [
          `Selling or arranging drugs, weapons, ammunition, explosives, counterfeits, stolen goods, data and accounts, fake documents and other goods or services whose sale is illegal is prohibited.`,
          `Instructions for making weapons and explosives, for committing crimes and for unauthorised access to other people's systems are prohibited; legal security research and education without instructions for misuse are allowed.`,
          `Promoting gambling and betting by unlicensed operators, human trafficking and "job" offers that are in fact fraud or exploitation is prohibited.`,
          `News, documentary and educational content about these topics is allowed.`,
        ],
      },
      {
        heading: `Scams, spam and deception`,
        items: [
          `Scams and deceptive practices are prohibited - phishing, fake contests and giveaways, fraudulent investments, pyramid schemes, fake fundraisers and links to malicious software.`,
          `Impersonating another person, brand, organisation or the Kine team, and deceptively claiming an official connection with them, is prohibited. Parody is allowed as long as it is clearly recognisable as parody.`,
          `Spam is prohibited - mass repetition of the same content, unsolicited advertising in comments and chat, and misleading titles, descriptions or thumbnails unrelated to the content.`,
        ],
      },
      {
        heading: `Manipulating Kine`,
        items: [
          `Artificially inflating numbers is prohibited - buying or selling views, subscribers, ratings and comments, or using bots, scripts or networks of accounts to do so.`,
          `Using multiple accounts to get around restrictions and bans or to influence ratings and recommendations is prohibited.`,
          `Misusing reports to silence opinions or to harass is prohibited; knowingly false reports are a violation of these guidelines.`,
        ],
      },
      {
        heading: `Copyright and intellectual property`,
        items: [
          `Only upload content you have the rights to - your own work, licensed content or uses permitted by law (for example quotation, parody or news reporting).`,
          `Anyone who believes their work has been used without permission can submit a notice through the form on the Copyright page (/copyright) - no account is needed. A moderator reviews the notice; if it is justified, we disable access to the content, and the uploader is told why and can respond.`,
          `Repeated copyright infringement leads to restrictions and ultimately to account termination.`,
          `Using other people's trademarks and logos in a way that misleads about the origin of content or a connection with their owner is prohibited.`,
        ],
      },
      {
        heading: `Advertising, sponsorship and AI-generated content`,
        items: [
          `You must clearly label paid promotions (sponsorship, product placement, affiliate links, free products in exchange for a review) in the video or its description.`,
          `Do not promote goods and services whose advertising is prohibited or restricted (for example unlicensed gambling, tobacco and alcohol products targeted at children, prescription medicines).`,
          `Label realistic-looking content created or altered by artificial intelligence that depicts real people, places or events in its title or description, so that it does not mislead anyone. Obvious exaggeration, fantasy and artistic edits do not need a label.`,
        ],
      },
      {
        heading: `Suitability for children`,
        items: [
          `When uploading, you state whether the content is suitable for children. Mark content with profanity, harsh violence, frightening scenes or adult themes as unsuitable for children.`,
          `Content made for children must not contain anything inappropriate and must not encourage them to do anything dangerous.`,
          `Kine is not intended for children under 13 (Terms of Service, section 2).`,
        ],
      },
      {
        heading: `Live streams and chat`,
        items: [
          `The same rules apply to streams as to videos. Do not stream criminal activity or real danger to life or health.`,
          `Automated checks may temporarily hide a stream in which nudity is detected until a moderator reviews it; in case of a serious violation we end the stream.`,
          `In your chat you can delete messages, mute and ban users, turn on slow mode and appoint moderators. Use these tools - you share responsibility for the atmosphere in your stream.`,
          `Do not misuse text-to-speech or other chat features to harass.`,
        ],
      },
      {
        heading: `Money from viewers`,
        items: [
          `Tips in streams and Super Thanks under videos are voluntary gifts. Do not pressure people into them, do not promise anything in return that you will not deliver, and do not use them to get around these guidelines.`,
          `Fake fundraisers, raffles and games of chance for tips (lotteries without a licence) and calls for dangerous or illegal conduct in exchange for money are prohibited.`,
          `The benefits of a channel membership must match what you promise. Messages attached to payments must follow these guidelines - otherwise we hide them.`,
          `In case of serious or repeated violations we may suspend receiving money and payouts (Terms of Service, section 10).`,
        ],
      },
      {
        heading: `How we enforce the guidelines`,
        items: [
          `We assess content based on reports from users and others, automated checks (in particular nudity detection and spam protection) and the work of moderators. Automation can at most hide content temporarily; permanent removal of content and account termination are decided by a person.`,
          `Depending on severity, intent and previous violations, we may: issue a warning, hide or remove content, limit its reach (not recommend it), mark it as unsuitable for children, restrict account features (uploading, streaming, comments, chat), suspend receiving money and payouts, temporarily block the account or terminate it.`,
          `Serious violations (sections 3 and 5, credible threats, terrorist content, publishing other people's personal data) lead to immediate account termination and may be reported to law enforcement authorities.`,
          `We inform you of every measure affecting your content or account with a statement of reasons - what we did, why and under which rule - and with information on how to appeal (Terms of Service, section 8).`,
          `You must not get around account termination by creating a new account.`,
        ],
      },
      {
        heading: `How to report a violation`,
        items: [
          `Use the Report button on a video, comment, post, profile or chat message.`,
          `Report copyright infringement through the form on the /copyright page.`,
          `Without an account, or for illegal content, write to ${LEGAL_CONTACT}: a link to the content, why you believe it is illegal or breaks the guidelines, your name and email address, and a statement that the information is provided in good faith and to the best of your knowledge. For content involving child abuse you do not have to give your name.`,
          `If there is an immediate threat to life or health, call 112 first.`,
        ],
      },
    ],
    footer: `We will update these guidelines over time and will let you know about significant changes in advance. By using Kine you agree to them. Effective from ${RULES_UPDATED.en}.`,
  },
};

// ============================================================================
// PODMÍNKY POUŽÍVÁNÍ
// ============================================================================

export const TERMS: LegalDoc = {
  cs: {
    title: `Podmínky používání služby Kine`,
    numbered: true,
    intro: [
      `Tyto podmínky používání (dále jen „podmínky“) upravují práva a povinnosti mezi provozovatelem služby Kine (dále jen „provozovatel“ nebo „my“) a každým, kdo službu používá (dále jen „uživatel“ nebo „ty“). Službou Kine (dále jen „Kine“ nebo „služba“) se rozumí webová platforma playkine.com, aplikace Kine do PC a Kine Clipper, mobilní aplikace Kine a všechny související funkce.`,
      ...(OPERATOR_CS ? [OPERATOR_CS] : []),
      `Kontakt: ${LEGAL_CONTACT}. Komunikovat s námi můžeš česky, slovensky nebo anglicky.`,
    ],
    summary: [
      `Kine je zdarma. Placené jsou jen doplňky (Kine Plus, Klipy Plus) a dobrovolné platby tvůrcům.`,
      `Obsah, který nahraješ, zůstává tvůj - nám dáváš jen licenci potřebnou k provozu služby.`,
      `Zasahujeme jen proti nezákonnému obsahu a porušení Pravidel komunity; vždy řekneme proč a můžeš se odvolat.`,
      `Předplatné zrušíš kdykoliv; jako spotřebitel od něj můžeš do 14 dnů odstoupit.`,
      `Účet můžeš kdykoliv smazat - zruší se tím i tvá předplatná. Platí české právo a tvá práva spotřebitele.`,
    ],
    sections: [
      {
        heading: `Úvodní ustanovení`,
        items: [
          `Podmínky tvoří obsah smlouvy o používání služby mezi tebou a provozovatelem. Smlouva vzniká založením účtu, při kterém vyjádříš souhlas s podmínkami a s Pravidly komunity. Kdo Kine používá bez účtu, je vázán podmínkami v rozsahu, v jakém se ho týkají.`,
          `Nedílnou součástí podmínek jsou Pravidla komunity (/rules). Jak zpracováváme osobní údaje, popisuje dokument Ochrana osobních údajů (/privacy).`,
          `Pro placené funkce platí navíc čl. 9 a 10 a informace zobrazené před zaplacením.`,
          `„Obsahem“ se rozumějí veškerá data, která uživatel na Kine nahraje nebo zveřejní - videa, Sparks, živá vysílání a jejich záznamy, klipy, náhledy, titulky, názvy a popisy, příspěvky, ankety, komentáře, zprávy v chatu, vzkazy u plateb, profilové údaje a obrázky. „Tvůrcem“ je uživatel, který obsah zveřejňuje. „Spotřebitelem“ je fyzická osoba, která při používání Kine nejedná v rámci své podnikatelské činnosti.`,
          `Smlouvu lze uzavřít v češtině nebo angličtině. Text podmínek u jednotlivých uživatelů zvlášť neukládáme; aktuální znění je vždy na této stránce a znění, se kterým jsi souhlasil(a), ti na požádání zašleme.`,
        ],
      },
      {
        heading: `Účet`,
        items: [
          `Kine smějí používat osoby starší 13 let. Vyžaduje-li právo tvé země pro souhlas se zpracováním osobních údajů v online službách vyšší věk (v Česku 15 let), potřebuješ do té doby souhlas rodiče nebo jiného zákonného zástupce, který za používání Kine odpovídá.`,
          `Placené funkce smějí používat jen zletilí, nebo nezletilí se souhlasem zákonného zástupce.`,
          `Při registraci uváděj pravdivé údaje. Účet je osobní; firma, značka nebo skupina může mít kanál, který spravuje oprávněná osoba. Více účtů mít můžeš, nesmíš je však používat k obcházení omezení, ke klamání ani k manipulaci s čísly.`,
          `Přihlašovací údaje chraň a nikomu je neposkytuj. Za činnost na svém účtu odpovídáš, ledaže došlo ke zneužití, které jsi nemohl(a) ovlivnit. Podezření na zneužití nám neprodleně oznam na ${LEGAL_CONTACT}.`,
          `Uživatelské jméno nesmí klamat ani porušovat práva jiných (například vydáváním se za jinou osobu nebo značku); v takovém případě tě můžeme požádat o změnu nebo jméno změnit.`,
          `Účet nesmíš prodat, pronajmout ani jinak převést na jinou osobu bez našeho souhlasu.`,
        ],
      },
      {
        heading: `Služba a její změny`,
        items: [
          `Základní funkce Kine poskytujeme bezplatně. Některé funkce jsou placené (čl. 9 a 10).`,
          `Kine se vyvíjí - funkce můžeme přidávat, měnit nebo rušit. Změnu, která podstatně zhorší placenou funkci, oznámíme předem; pokud s ní nesouhlasíš, můžeš předplatné ukončit. Funkce označené jako testovací (beta) mohou fungovat omezeně nebo skončit.`,
          `Nahrávání a ukládání mají limity (například délka videa, počet nahrání za den a velikost úložiště účtu); platné limity vidíš v aplikaci. Limity můžeme přiměřeně měnit, zejména kvůli nákladům, bezpečnosti a předcházení zneužití. Snížení limitu úložiště nemaže už nahraný obsah - jen nelze nahrávat další, dokud se místo neuvolní.`,
          `Usilujeme o nepřetržitý a bezpečný provoz, dostupnost bez přerušení ale zaručit nemůžeme (údržba, výpadky dodavatelů, vyšší moc).`,
        ],
      },
      {
        heading: `Obsah uživatelů`,
        items: [
          `K obsahu, který nahraješ, ti zůstávají všechna práva. Neprohlašujeme se za jeho autory ani vlastníky.`,
          `Nahráním obsahu nám uděluješ nevýhradní, bezúplatnou a celosvětovou licenci, s právem udělit podlicenci našim dodavatelům, kteří pro nás službu technicky zajišťují, k užití obsahu v rozsahu nutném pro provoz a rozvoj Kine - zejména k jeho uložení, technickému zpracování (převod formátu, komprese, náhledy, ukázky po najetí myší, automatické titulky), zpřístupnění ostatním podle zvolené viditelnosti, doporučování, sdílení odkazem a zobrazení v náhledech odkazů a ve vloženém přehrávači Kine.`,
          `Tvůj obsah bez tvého souhlasu nepoužijeme v reklamních kampaních Kine mimo službu.`,
          `Licence trvá po dobu zveřejnění obsahu a zaniká jeho smazáním nebo smazáním účtu, s výjimkou kopií v zálohách (zmizí do několika týdnů), obsahu, který musíme uchovat podle zákona nebo kvůli vyřízení sporu či porušení, a kopií, které si uživatelé oprávněně uložili k přehrávání bez připojení.`,
          `Odpovídáš za to, že k obsahu máš všechna potřebná práva (hudba, záběry, cizí díla, ochranné známky), že máš souhlas rozpoznatelných osob, je-li potřeba, a že obsah neporušuje zákon ani Pravidla komunity. Za škodu, kterou porušením způsobíš nám nebo jiným, odpovídáš podle zákona.`,
          `Obsah předem nekontrolujeme; jsme poskytovatelem hostingových služeb. Za obsah odpovídá ten, kdo ho zveřejnil.`,
        ],
      },
      {
        heading: `Pravidla chování`,
        paragraphs: [`Co je a není dovolené, popisují Pravidla komunity (/rules). Kromě nich platí:`],
        items: [
          `Je zakázáno porušovat právní předpisy nebo práva jiných.`,
          `Je zakázáno přistupovat ke Kine automatizovaně (roboti, skripty, hromadné stahování obsahu) bez našeho souhlasu; výjimkou jsou internetové vyhledávače, které respektují soubor robots.txt.`,
          `Je zakázáno narušovat bezpečnost a provoz Kine - hledat a zneužívat zranitelnosti, obcházet ochranu obsahu, limity, kontrolu předplatného a plateb, přetěžovat servery nebo šířit škodlivý software.`,
          `Je zakázáno obcházet zákazy a omezení (například založením nového účtu po zrušení), uměle ovlivňovat čísla, hodnocení a doporučování a zneužívat oznamování obsahu nebo odvolání.`,
          `Je zakázáno používat Kine k rozesílání nevyžádaných obchodních sdělení.`,
          `Bezpečnostní chybu, kterou najdeš, nám prosím nahlas na ${LEGAL_CONTACT}. Za nahlášení v dobré víře, při kterém chybu nezneužiješ a nikomu neublížíš, proti tobě nepodnikneme právní kroky.`,
        ],
      },
      {
        heading: `Živé vysílání`,
        items: [
          `Vysílat můžeš z Kine Clipperu nebo jiného programu (například OBS) pomocí klíče, který ti Kine vydá. Klíč je důvěrný a za vysílání pod tvým klíčem odpovídáš; při podezření na únik si vygeneruj nový.`,
          `Pro vysílání platí Pravidla komunity. Automatická kontrola obsahu může přenos dočasně skrýt, než ho posoudí moderátor; při vážném porušení vysílání ukončíme.`,
          `Po skončení vysílání se rozhodneš, co se záznamem: stáhnout, zveřejnit jako video, nebo zahodit. Zahozený záznam mažeme.`,
          `Zprávy v chatu a vzkazy u podpor jsou veřejné a vysílání je může číst nahlas (syntéza řeči).`,
        ],
      },
      {
        heading: `Automatizované systémy a doporučování`,
        items: [
          `K moderaci používáme automatické nástroje: detekci nahoty v náhledech, profilových fotkách, bannerech a přenosech, ochranu před spamem a omezení počtu akcí. Automatika může obsah dočasně skrýt nebo akci zastavit; trvalé odstranění obsahu a zrušení účtu vždy posuzuje člověk.`,
          `Videa na hlavní stránce a další doporučení řadíme podle těchto hlavních kritérií: čerstvost videa, tvé odběry, kategorie a hashtagy, které sleduješ, oblíbenost, prvek náhody a to, zda jsi video už viděl(a). U doporučení je popisek, proč se ti video nabízí.`,
          `Doporučování můžeš ovlivnit volbami „Nezajímá mě“ a „Nedoporučovat kanál“, skrytím videa, nastavením hlavní stránky (dlouhá videa nebo Sparks) a mazáním historie sledování.`,
          `Automatické titulky vytváří umělá inteligence a mohou obsahovat chyby. Hodnocení tvůrců (Rating) vychází z hodnocení diváků.`,
          `Automatizované rozhodování, které by mělo vůči tobě právní nebo obdobně závažné účinky, neprovádíme.`,
        ],
      },
      {
        heading: `Oznámení, moderace a odvolání`,
        items: [
          `Nezákonný obsah nebo porušení Pravidel komunity můžeš nahlásit tlačítkem Nahlásit, formulářem /copyright nebo e-mailem na ${LEGAL_CONTACT}, i bez účtu. Oznámení by mělo obsahovat přesný odkaz na obsah, vysvětlení, proč je obsah nezákonný nebo v rozporu s pravidly, tvé jméno a e-mail a prohlášení, že údaje uvádíš v dobré víře.`,
          `Přijetí oznámení potvrdíme, známe-li tvůj kontakt, a o výsledku tě bez zbytečného odkladu informujeme, včetně možností nápravy.`,
          `Oznámení i jiné podněty posuzujeme pečlivě, objektivně a přiměřeně, s ohledem na práva a oprávněné zájmy všech zúčastněných, zejména na svobodu projevu.`,
          `Můžeme přijmout tato opatření: odstranění nebo znepřístupnění obsahu, omezení jeho viditelnosti (nedoporučování, označení jako nevhodný pro děti), omezení funkcí účtu, pozastavení příjmu peněz a výplat, dočasné zablokování nebo zrušení účtu.`,
          `O opatření tě informujeme s odůvodněním: o jaké opatření jde, v jakém rozsahu a na jak dlouho, jaké skutečnosti k němu vedly, zda jsme jednali na základě oznámení, zda byly použity automatizované prostředky, o které ustanovení podmínek nebo zákona se opíráme a jak se můžeš bránit. To neplatí, pokud nám to zakazuje zákon nebo orgán veřejné moci, a u hromadného klamavého obchodního obsahu (spamu).`,
          `Proti opatření - a pokud jsi obsah nahlásil(a), také proti rozhodnutí nezasáhnout - se můžeš do 6 měsíců odvolat na ${LEGAL_CONTACT} (stačí odpovědět na naše oznámení). Odvolání posoudí člověk bez zbytečného odkladu; zjistíme-li, že opatření nebylo oprávněné, zrušíme ho.`,
          `Uživateli, který opakovaně zveřejňuje zjevně nezákonný obsah, můžeme po předchozím upozornění pozastavit poskytování služby. Oznámení od osoby, která opakovaně podává zjevně neopodstatněná oznámení, můžeme na přiměřenou dobu přestat vyřizovat.`,
          `Na rozhodnutí orgánů veřejné moci, včetně příkazů k odstranění teroristického obsahu podle práva Evropské unie, reagujeme ve stanovených lhůtách. Získáme-li informace o trestném činu, který ohrožuje život nebo bezpečnost osob, oznámíme to příslušným orgánům.`,
          `Kontaktním místem pro uživatele i pro orgány veřejné moci podle nařízení EU o digitálních službách je ${LEGAL_CONTACT}; komunikujeme česky a anglicky.`,
          `Tím nejsou dotčena tvá práva obrátit se na soud nebo na příslušný orgán dozoru.`,
        ],
      },
      {
        heading: `Placené funkce: předplatné a dary`,
        items: [
          `Kine Plus, Klipy Plus a jejich kombinace jsou měsíční předplatné placené předem prostřednictvím platební služby Stripe. Cenu včetně daně, pokud se uplatní, a měnu (zpravidla EUR, v USA USD) uvidíš před zaplacením.`,
          `Předplatné se automaticky obnovuje vždy o další měsíc, dokud ho nezrušíš. Zrušit ho můžeš kdykoliv ve správě předplatného na stránce /plus; platí pak do konce zaplaceného období. Za nevyčerpanou část období se při zrušení nic nevrací, nejde-li o odstoupení nebo o vadu podle tohoto článku.`,
          `Nepodaří-li se obnovení zaplatit, výhody předplatného po krátké době (zpravidla po 3 dnech) skončí; po úspěšném zaplacení se obnoví.`,
          `Změnu ceny předplatného oznámíme nejméně 30 dní předem e-mailem nebo v aplikaci. Nová cena platí od nejbližšího obnovení po uplynutí této lhůty; pokud s ní nesouhlasíš, předplatné před obnovením zrušíš.`,
          `Slevové kódy a akce platí za podmínek uvedených u akce.`,
          `Odstoupení: jako spotřebitel můžeš od smlouvy o předplatném odstoupit bez udání důvodu do 14 dnů od jejího uzavření. Předplatné začíná na tvou výslovnou žádost hned po zaplacení (potvrzuješ ji při platbě), proto při odstoupení uhradíš poměrnou část ceny za dobu do odstoupení a zbytek ti vrátíme do 14 dnů stejným způsobem, jakým jsi platil(a). Odstoupení stačí poslat e-mailem na ${LEGAL_CONTACT}; můžeš použít vzor: „Oznamuji, že odstupuji od smlouvy o předplatném [Kine Plus / Klipy Plus], uzavřené dne [datum]. E-mail účtu: [e-mail]. Jméno: [jméno].“`,
          `Vady: pokud placená funkce nefunguje tak, jak má, napiš nám na ${LEGAL_CONTACT}. Vadu odstraníme v přiměřené lhůtě, nejpozději do 30 dnů; nepodaří-li se to, máš nárok na přiměřenou slevu nebo můžeš od smlouvy odstoupit. Tvá zákonná práva z vadného plnění u digitálního obsahu a digitálních služeb tím nejsou dotčena.`,
          `Dary Kine (Podpořit Kine) jsou dobrovolné a nevracejí se, ledaže to vyžaduje zákon nebo jde o chybu či podvod.`,
          `Platby zpracovává Stripe; čísla platebních karet nevidíme. Neodůvodněné zpochybnění platby u banky (chargeback) může vést k pozastavení placených funkcí.`,
        ],
      },
      {
        heading: `Platby tvůrcům`,
        items: [
          `Předplatné kanálu, podpory ve vysílání a Super díky pod videi jsou platby tvůrci. Kine je technicky zprostředkovává přes Stripe a ponechává si z nich poplatek, který uvidíš předem (nyní 15 %, u podpor nejméně částku pokrývající náklady platby).`,
          `Podpory a Super díky jsou dobrovolné dary bez nároku na protiplnění, kromě zobrazení vzkazu. Nevracejí se, ledaže to vyžaduje zákon nebo jde o chybu či podvod. Skrytí vzkazu tvůrcem nebo moderátorem nemá na platbu vliv.`,
          `Výhody předplatného kanálu určuje a poskytuje tvůrce a za jejich poskytnutí odpovídá.`,
          `Tvůrce, který přijímá peníze, potřebuje vlastní účet u Stripe, musí projít jeho ověřením a souhlasit s jeho podmínkami. Výplaty probíhají podle harmonogramu Stripe (zpravidla jednou měsíčně). Nejnižší a nejvyšší cenu předplatného kanálu a částky podpor zobrazuje aplikace.`,
          `Je-li platba vrácena nebo úspěšně zpochybněna (chargeback), odpovídající částka se tvůrci odečte z jeho zůstatku u Stripe.`,
          `Při podezření na podvod, při vážném nebo opakovaném porušení podmínek nebo na základě rozhodnutí orgánu veřejné moci můžeme příjem peněz a výplaty pozastavit; o důvodu tě informujeme (čl. 8).`,
          `Tvůrce sám odpovídá za své daně, odvody a další povinnosti (například registraci k dani z přidané hodnoty). Uloží-li nám zákon poskytovat údaje o platbách správci daně, učiníme tak.`,
        ],
      },
      {
        heading: `Aplikace Kine do PC, Kine Clipper a mobilní aplikace`,
        items: [
          `K aplikacím ti udělujeme nevýhradní, nepřevoditelnou a odvolatelnou licenci k instalaci a používání pro osobní účely v souladu s těmito podmínkami.`,
          `Aplikace nesmíš upravovat, zpětně analyzovat, dekompilovat, obcházet jejich ochranu nebo kontrolu předplatného ani šířit jejich upravené verze - s výjimkou případů, které výslovně dovoluje zákon.`,
          `Aplikace se samy aktualizují. Starší verze mohou kvůli bezpečnosti a dodržování pravidel přestat fungovat nebo ztratit placené funkce. Testovací verze poskytujeme bez záruky.`,
          `Aplikace nahrávají obrazovku, zvuk a případně kameru jen na tvém zařízení; na Kine nic neodesílají, dokud obsah nenahraješ ty (nebo automatické nahrávání, pokud si ho s Klipy Plus zapneš).`,
          `Za nahraný a zveřejněný obsah odpovídáš ty - například za hlasy spoluhráčů, hudbu ve hře a dodržení pravidel vydavatelů her.`,
        ],
      },
      {
        heading: `Duševní vlastnictví Kine`,
        items: [
          `Název a logo Kine, vzhled služby, software a další náš obsah jsou chráněny právem a patří provozovateli nebo jeho poskytovatelům licencí. Bez našeho souhlasu je nesmíš užívat jinak, než jak umožňují tyto podmínky; odkazovat na Kine a popisovat ho můžeš.`,
          `Návrhy a zpětnou vazbu, které nám pošleš, můžeme bezplatně využít ke zlepšení Kine.`,
        ],
      },
      {
        heading: `Ukončení smlouvy`,
        items: [
          `Smlouvu můžeš kdykoliv ukončit smazáním účtu v Nastavení → Účet. Se smazáním účtu zrušíme i tvá předplatná u Stripe (Kine Plus i členství u tvůrců) a tvůj obsah smažeme, jak popisuje dokument Ochrana osobních údajů.`,
          `Při vážném porušení podmínek nebo Pravidel komunity, nebo vyžaduje-li to zákon, můžeme účet zrušit s okamžitou účinností. V ostatních případech můžeme smlouvu vypovědět s výpovědní dobou 30 dnů (například při ukončení provozu Kine); informujeme tě e-mailem nebo v aplikaci.`,
          `Ukončíme-li smlouvu bez tvého zavinění, vrátíme ti poměrnou část předem zaplaceného předplatného.`,
          `Ustanovení, která mají podle své povahy platit i po skončení smlouvy (například licence k uchovaným kopiím, odpovědnost a rozhodné právo), platí dál.`,
        ],
      },
      {
        heading: `Odpovědnost`,
        items: [
          `Kine poskytujeme v podobě, v jaké je, a nezaručujeme, že bude vždy dostupná, bez chyb nebo vhodná pro konkrétní účel - s výjimkou práv, která ti dává zákon (zejména práva spotřebitele z vadného plnění u placených funkcí).`,
          `Za obsah uživatelů neodpovídáme. Jakmile se o nezákonném obsahu dozvíme, bez zbytečného odkladu ho odstraníme nebo znepřístupníme.`,
          `Vůči spotřebitelům odpovídáme podle zákona. Vůči uživatelům, kteří Kine používají v rámci svého podnikání, vylučujeme v rozsahu, který zákon dovoluje, odpovědnost za škodu způsobenou z lehké nedbalosti a za ušlý zisk; tím není dotčena odpovědnost za újmu na přirozených právech člověka ani za škodu způsobenou úmyslně nebo z hrubé nedbalosti.`,
          `Za obsah webů a služeb třetích stran, na které Kine odkazuje, neodpovídáme.`,
          `Neodpovídáme za nesplnění povinností způsobené okolnostmi, které nemůžeme ovlivnit (vyšší moc, výpadky dodavatelů, kybernetické útoky, zásahy orgánů veřejné moci).`,
        ],
      },
      {
        heading: `Změny podmínek`,
        items: [
          `Podmínky a Pravidla komunity můžeme přiměřeně měnit - zejména kvůli změnám právních předpisů, změnám služby, bezpečnosti nebo zkušenostem z provozu.`,
          `O podstatných změnách tě informujeme nejméně 14 dní před jejich účinností e-mailem nebo v aplikaci. Změny vynucené zákonem nebo nutné z bezpečnostních důvodů mohou nabýt účinnosti dříve.`,
          `Pokud se změnou nesouhlasíš, můžeš smlouvu do dne její účinnosti ukončit smazáním účtu. Dalším používáním Kine po účinnosti změn je přijímáš.`,
          `Změny ceny předplatného se řídí čl. 9.`,
        ],
      },
      {
        heading: `Převod smlouvy`,
        items: [
          `Souhlasíš s tím, že provozovatel může práva a povinnosti z této smlouvy převést na osobu, která převezme provoz Kine, zejména na obchodní společnost, kterou provozovatel založí nebo ovládá. O převodu tě informujeme; tvé postavení se tím nezhorší, a pokud s převodem nesouhlasíš, můžeš smlouvu ukončit.`,
        ],
      },
      {
        heading: `Komunikace`,
        items: [
          `Oznámení ti zasíláme e-mailem na adresu tvého účtu nebo v aplikaci (oznámení na Kine). Nám můžeš psát na ${LEGAL_CONTACT}.`,
          `Udržuj e-mail u účtu aktuální - chodí na něj důležitá oznámení (například o změně podmínek nebo o opatření týkajícím se tvého účtu).`,
        ],
      },
      {
        heading: `Rozhodné právo a řešení sporů`,
        items: [
          `Smlouva se řídí právem České republiky. Jsi-li spotřebitel s bydlištěm v jiném státě, nepřicházíš o ochranu, kterou ti poskytují kogentní předpisy státu tvého bydliště.`,
          `Spory rozhodují příslušné soudy České republiky; spotřebitel může žalovat i u soudu státu svého bydliště.`,
          `Spotřebitel může využít mimosoudní řešení spotřebitelských sporů u České obchodní inspekce (www.coi.cz, oddíl Informace o ADR), případně u jiného příslušného subjektu mimosoudního řešení sporů.`,
          `Dozor nad ochranou spotřebitele vykonává Česká obchodní inspekce a nad ochranou osobních údajů Úřad pro ochranu osobních údajů.`,
          `Nejdřív nám ale prosím napiš na ${LEGAL_CONTACT} - většinu věcí vyřešíme rychle a domluvou.`,
        ],
      },
      {
        heading: `Závěrečná ustanovení`,
        items: [
          `Je-li některé ustanovení neplatné nebo neúčinné, ostatní ustanovení tím nejsou dotčena; neplatné ustanovení nahradíme ustanovením, které se mu svým smyslem co nejvíce blíží.`,
          `Podmínky jsou vyhotoveny v češtině a angličtině. V případě rozporu má přednost česká verze, nestanoví-li kogentní právo jinak.`,
          `Tyto podmínky jsou účinné od ${TERMS_UPDATED.cs} a nahrazují předchozí znění.`,
        ],
      },
    ],
    footer: `Kontakt: ${LEGAL_CONTACT}. Poslední změna: ${TERMS_UPDATED.cs}.`,
  },
  en: {
    title: `Kine Terms of Service`,
    numbered: true,
    intro: [
      `These terms of service (the "terms") govern the rights and obligations between the operator of the Kine service (the "operator" or "we") and everyone who uses the service (the "user" or "you"). The Kine service ("Kine" or the "service") means the web platform playkine.com, the Kine for PC and Kine Clipper applications, the Kine mobile applications and all related features.`,
      ...(OPERATOR_EN ? [OPERATOR_EN] : []),
      `Contact: ${LEGAL_CONTACT}. You can communicate with us in Czech, Slovak or English.`,
    ],
    summary: [
      `Kine is free. Only extras (Kine Plus, Clips Plus) and voluntary payments to creators cost money.`,
      `Content you upload remains yours - you only give us the licence needed to run the service.`,
      `We only act against illegal content and breaches of the Community Guidelines; we always tell you why, and you can appeal.`,
      `You can cancel a subscription at any time; as a consumer you can withdraw from it within 14 days.`,
      `You can delete your account at any time - this also cancels your subscriptions. Czech law and your consumer rights apply.`,
    ],
    sections: [
      {
        heading: `Introductory provisions`,
        items: [
          `These terms form the content of the contract for the use of the service between you and the operator. The contract is concluded when you create an account and agree to these terms and the Community Guidelines. Anyone using Kine without an account is bound by these terms to the extent they apply to them.`,
          `The Community Guidelines (/rules) form an integral part of these terms. How we process personal data is described in the Privacy Policy (/privacy).`,
          `Paid features are additionally governed by sections 9 and 10 and by the information shown before payment.`,
          `"Content" means all data that a user uploads or publishes on Kine - videos, Sparks, live streams and their recordings, clips, thumbnails, captions, titles and descriptions, posts, polls, comments, chat messages, messages attached to payments, profile details and images. A "creator" is a user who publishes content. A "consumer" is a natural person who does not use Kine in the course of their business.`,
          `The contract can be concluded in Czech or English. We do not store the text of the terms separately for each user; the current version is always available on this page, and we will send you the version you agreed to on request.`,
        ],
      },
      {
        heading: `Account`,
        items: [
          `Kine may be used by persons aged 13 or over. If the law of your country requires a higher age for consenting to the processing of personal data in online services (15 in the Czech Republic), you need the consent of a parent or other legal guardian, who is responsible for your use of Kine, until you reach that age.`,
          `Paid features may only be used by adults, or by minors with the consent of a legal guardian.`,
          `Provide accurate information when registering. Your account is personal; a company, brand or group may have a channel managed by an authorised person. You may have more than one account, but you must not use them to get around restrictions, to deceive or to manipulate numbers.`,
          `Protect your login details and do not share them with anyone. You are responsible for activity on your account unless it results from misuse you could not have prevented. Report any suspected misuse to us without delay at ${LEGAL_CONTACT}.`,
          `Your username must not be misleading or infringe the rights of others (for example by impersonating another person or brand); in such a case we may ask you to change it or change it ourselves.`,
          `You must not sell, rent out or otherwise transfer your account to another person without our consent.`,
        ],
      },
      {
        heading: `The service and changes to it`,
        items: [
          `We provide Kine's basic features free of charge. Some features are paid (sections 9 and 10).`,
          `Kine keeps evolving - we may add, change or remove features. We will announce in advance any change that significantly worsens a paid feature; if you do not agree with it, you can end your subscription. Features marked as testing (beta) may work in a limited way or be discontinued.`,
          `Uploading and storage have limits (for example video length, number of uploads per day and account storage); the current limits are shown in the app. We may adjust the limits reasonably, in particular because of costs, security and abuse prevention. Lowering the storage limit does not delete content you have already uploaded - you just cannot upload more until space is freed.`,
          `We strive for continuous and secure operation, but we cannot guarantee uninterrupted availability (maintenance, outages of our providers, force majeure).`,
        ],
      },
      {
        heading: `User content`,
        items: [
          `You keep all rights to the content you upload. We do not claim to be its author or owner.`,
          `By uploading content you grant us a non-exclusive, royalty-free, worldwide licence, with the right to grant sub-licences to the providers who technically operate the service for us, to use the content to the extent necessary to operate and develop Kine - in particular to store it, process it technically (format conversion, compression, thumbnails, hover previews, automatic captions), make it available to others according to the visibility you choose, recommend it, let people share it by link, and show it in link previews and in the embedded Kine player.`,
          `We will not use your content in Kine advertising campaigns outside the service without your consent.`,
          `The licence lasts for as long as the content is published and ends when you delete the content or your account, except for copies in backups (which disappear within a few weeks), content we are required to keep by law or to resolve a dispute or violation, and copies that users have lawfully saved for offline playback.`,
          `You are responsible for having all the necessary rights to your content (music, footage, other people's works, trademarks), for having the consent of identifiable persons where required, and for the content not breaking the law or the Community Guidelines. You are liable under the law for any damage your breach causes to us or others.`,
          `We do not check content in advance; we are a hosting service provider. The person who published content is responsible for it.`,
        ],
      },
      {
        heading: `Rules of conduct`,
        paragraphs: [`What is and is not allowed is described in the Community Guidelines (/rules). In addition:`],
        items: [
          `You must not break the law or infringe the rights of others.`,
          `You must not access Kine by automated means (bots, scripts, mass downloading of content) without our consent; search engines that respect the robots.txt file are an exception.`,
          `You must not interfere with Kine's security or operation - look for and exploit vulnerabilities, circumvent content protection, limits, subscription or payment checks, overload our servers or spread malicious software.`,
          `You must not get around bans and restrictions (for example by creating a new account after termination), artificially influence numbers, ratings and recommendations, or misuse reports or appeals.`,
          `You must not use Kine to send unsolicited commercial communications.`,
          `If you find a security vulnerability, please report it to ${LEGAL_CONTACT}. We will not take legal action against good-faith reports in which you do not exploit the vulnerability or harm anyone.`,
        ],
      },
      {
        heading: `Live streaming`,
        items: [
          `You can stream from Kine Clipper or another program (for example OBS) using the key Kine issues to you. The key is confidential and you are responsible for streams under your key; if you suspect it has leaked, generate a new one.`,
          `The Community Guidelines apply to streams. Automated content checks may temporarily hide a stream until a moderator reviews it; in case of a serious violation we end the stream.`,
          `When a stream ends, you decide what happens to the recording: download it, publish it as a video, or discard it. Discarded recordings are deleted.`,
          `Chat messages and messages attached to tips are public, and the stream may read them aloud (text-to-speech).`,
        ],
      },
      {
        heading: `Automated systems and recommendations`,
        items: [
          `We use automated tools for moderation: nudity detection in thumbnails, profile pictures, banners and streams, spam protection and rate limits. Automation may temporarily hide content or stop an action; permanent removal of content and account termination are always reviewed by a person.`,
          `We rank videos on the home page and other recommendations by these main criteria: how recent the video is, your subscriptions, the categories and hashtags you watch, popularity, an element of randomness, and whether you have already seen the video. Recommendations show a label explaining why the video is suggested.`,
          `You can influence recommendations with "Not interested" and "Don't recommend channel", by hiding videos, through your home page settings (long videos or Sparks) and by clearing your watch history.`,
          `Automatic captions are created by artificial intelligence and may contain errors. Creator ratings (Rating) are based on viewers' ratings.`,
          `We do not make automated decisions that produce legal or similarly significant effects concerning you.`,
        ],
      },
      {
        heading: `Notices, moderation and appeals`,
        items: [
          `You can report illegal content or breaches of the Community Guidelines with the Report button, through the /copyright form or by email to ${LEGAL_CONTACT}, even without an account. A notice should contain the exact link to the content, an explanation of why the content is illegal or breaks the guidelines, your name and email address, and a statement that the information is provided in good faith.`,
          `We will confirm receipt of the notice if we know your contact details, and inform you of the outcome without undue delay, including the available means of redress.`,
          `We assess notices and other reports diligently, objectively and proportionately, with due regard to the rights and legitimate interests of all parties involved, in particular freedom of expression.`,
          `We may take the following measures: removing or disabling access to content, restricting its visibility (not recommending it, marking it as unsuitable for children), restricting account features, suspending receiving money and payouts, temporarily blocking or terminating the account.`,
          `We will inform you of any measure with a statement of reasons: what the measure is, its scope and duration, the facts and circumstances that led to it, whether we acted on a notice, whether automated means were used, which provision of these terms or of the law we rely on, and how you can seek redress. This does not apply where the law or a public authority prohibits it, or to high-volume deceptive commercial content (spam).`,
          `You can appeal against a measure - and, if you reported content, against a decision not to act - within 6 months by writing to ${LEGAL_CONTACT} (replying to our notification is enough). A person will review the appeal without undue delay; if we find that the measure was not justified, we will reverse it.`,
          `We may, after a prior warning, suspend the service for users who frequently publish manifestly illegal content. We may stop processing, for a reasonable period, notices from a person who frequently submits manifestly unfounded notices.`,
          `We respond to orders from public authorities, including removal orders for terrorist content under European Union law, within the required time limits. If we become aware of information giving rise to a suspicion of a criminal offence involving a threat to the life or safety of persons, we will inform the competent authorities.`,
          `The point of contact for users and for public authorities under the EU Digital Services Act is ${LEGAL_CONTACT}; we communicate in Czech and English.`,
          `This does not affect your right to go to court or to contact the competent supervisory authority.`,
        ],
      },
      {
        heading: `Paid features: subscriptions and donations`,
        items: [
          `Kine Plus, Clips Plus and their combination are monthly subscriptions paid in advance through the Stripe payment service. You will see the price, including tax where applicable, and the currency (usually EUR, USD in the USA) before you pay.`,
          `A subscription renews automatically for another month until you cancel it. You can cancel at any time in subscription management on the /plus page; it then remains active until the end of the paid period. Cancelling does not refund the unused part of the period, unless you withdraw or claim a defect under this section.`,
          `If a renewal payment fails, the subscription benefits end after a short time (usually 3 days); they return once the payment succeeds.`,
          `We will announce any change to the subscription price at least 30 days in advance by email or in the app. The new price applies from the first renewal after that period; if you do not agree with it, cancel the subscription before it renews.`,
          `Discount codes and promotions apply under the conditions stated with the promotion.`,
          `Withdrawal: as a consumer, you can withdraw from the subscription contract without giving any reason within 14 days of concluding it. The subscription starts immediately after payment at your express request (which you confirm when paying), so if you withdraw you pay a proportionate part of the price for the period until withdrawal, and we refund the rest within 14 days using the same payment method you used. Simply send your withdrawal by email to ${LEGAL_CONTACT}; you can use this template: "I hereby withdraw from the [Kine Plus / Clips Plus] subscription contract concluded on [date]. Account email: [email]. Name: [name]."`,
          `Defects: if a paid feature does not work as it should, write to us at ${LEGAL_CONTACT}. We will remedy the defect within a reasonable time, no later than 30 days; if we cannot, you are entitled to a reasonable price reduction or may withdraw from the contract. This does not affect your statutory rights regarding defective digital content and digital services.`,
          `Donations to Kine (Support Kine) are voluntary and non-refundable, unless required by law or in case of error or fraud.`,
          `Payments are processed by Stripe; we do not see card numbers. Disputing a payment with your bank without a valid reason (chargeback) may lead to suspension of paid features.`,
        ],
      },
      {
        heading: `Payments to creators`,
        items: [
          `Channel memberships, tips in streams and Super Thanks under videos are payments to the creator. Kine facilitates them technically through Stripe and keeps a fee shown to you in advance (currently 15%, and for tips at least an amount covering the payment costs).`,
          `Tips and Super Thanks are voluntary gifts with no entitlement to anything in return other than the display of your message. They are non-refundable, unless required by law or in case of error or fraud. A creator or moderator hiding a message does not affect the payment.`,
          `The benefits of a channel membership are defined and provided by the creator, who is responsible for providing them.`,
          `A creator who receives money needs their own Stripe account, must complete Stripe's verification and agree to Stripe's terms. Payouts follow Stripe's schedule (usually once a month). The minimum and maximum channel membership price and tip amounts are shown in the app.`,
          `If a payment is refunded or successfully disputed (chargeback), the corresponding amount is deducted from the creator's Stripe balance.`,
          `We may suspend receiving money and payouts in case of suspected fraud, serious or repeated breaches of these terms, or based on an order from a public authority; we will tell you the reason (section 8).`,
          `Creators are solely responsible for their own taxes, contributions and other obligations (for example VAT registration). If the law requires us to provide payment information to tax authorities, we will do so.`,
        ],
      },
      {
        heading: `Kine for PC, Kine Clipper and the mobile apps`,
        items: [
          `We grant you a non-exclusive, non-transferable and revocable licence to install and use the apps for personal purposes in accordance with these terms.`,
          `You must not modify, reverse engineer or decompile the apps, circumvent their protection or subscription checks, or distribute modified versions - except where expressly permitted by law.`,
          `The apps update themselves. For security and compliance reasons, older versions may stop working or lose paid features. Test versions are provided without warranty.`,
          `The apps record your screen, sound and, if enabled, your camera only on your device; nothing is sent to Kine until you upload content (or automatic uploading does, if you turn it on with Clips Plus).`,
          `You are responsible for what you record and publish - for example your teammates' voices, in-game music and compliance with game publishers' rules.`,
        ],
      },
      {
        heading: `Kine's intellectual property`,
        items: [
          `The Kine name and logo, the look of the service, the software and our other content are legally protected and belong to the operator or its licensors. You must not use them without our consent other than as these terms allow; you may link to Kine and describe it.`,
          `We may use suggestions and feedback you send us free of charge to improve Kine.`,
        ],
      },
      {
        heading: `Ending the contract`,
        items: [
          `You can end the contract at any time by deleting your account in Settings → Account. When you delete your account, we also cancel your Stripe subscriptions (Kine Plus and channel memberships) and delete your content as described in the Privacy Policy.`,
          `In case of a serious breach of these terms or the Community Guidelines, or where required by law, we may terminate your account with immediate effect. In other cases we may terminate the contract with 30 days' notice (for example if we shut down Kine); we will inform you by email or in the app.`,
          `If we end the contract through no fault of yours, we will refund the proportionate part of any prepaid subscription.`,
          `Provisions that by their nature should survive the end of the contract (for example the licence for retained copies, liability and governing law) continue to apply.`,
        ],
      },
      {
        heading: `Liability`,
        items: [
          `We provide Kine as it is and do not guarantee that it will always be available, error-free or fit for a particular purpose - without prejudice to your statutory rights (in particular consumer rights regarding defects in paid features).`,
          `We are not responsible for user content. Once we become aware of illegal content, we remove it or disable access to it without undue delay.`,
          `Towards consumers, we are liable in accordance with the law. Towards users who use Kine in the course of their business, we exclude, to the extent permitted by law, liability for damage caused by slight negligence and for lost profits; this does not affect liability for harm to a person's natural rights or for damage caused intentionally or by gross negligence.`,
          `We are not responsible for the content of third-party websites and services that Kine links to.`,
          `We are not liable for failure to perform caused by circumstances beyond our control (force majeure, outages of our providers, cyberattacks, actions of public authorities).`,
        ],
      },
      {
        heading: `Changes to these terms`,
        items: [
          `We may reasonably change these terms and the Community Guidelines - in particular because of changes in the law, changes to the service, security or operational experience.`,
          `We will inform you of significant changes at least 14 days before they take effect, by email or in the app. Changes required by law or necessary for security reasons may take effect sooner.`,
          `If you do not agree with a change, you can end the contract by deleting your account before the change takes effect. By continuing to use Kine after the changes take effect, you accept them.`,
          `Changes to the subscription price are governed by section 9.`,
        ],
      },
      {
        heading: `Transfer of the contract`,
        items: [
          `You agree that the operator may transfer the rights and obligations under this contract to a person who takes over the operation of Kine, in particular to a company founded or controlled by the operator. We will inform you of the transfer; your position will not be worsened by it, and if you do not agree with the transfer, you can end the contract.`,
        ],
      },
      {
        heading: `Communication`,
        items: [
          `We send you notices by email to your account address or in the app (Kine notifications). You can write to us at ${LEGAL_CONTACT}.`,
          `Keep your account email up to date - important notices are sent there (for example about changes to these terms or about measures concerning your account).`,
        ],
      },
      {
        heading: `Governing law and dispute resolution`,
        items: [
          `The contract is governed by the law of the Czech Republic. If you are a consumer living in another country, you do not lose the protection given to you by the mandatory rules of your country of residence.`,
          `Disputes are decided by the competent courts of the Czech Republic; consumers can also bring proceedings before the courts of their country of residence.`,
          `Consumers can use out-of-court resolution of consumer disputes at the Czech Trade Inspection Authority (www.coi.cz, ADR section), or another competent out-of-court dispute resolution body.`,
          `Consumer protection is supervised by the Czech Trade Inspection Authority and personal data protection by the Office for Personal Data Protection.`,
          `But please write to us first at ${LEGAL_CONTACT} - we can resolve most things quickly and amicably.`,
        ],
      },
      {
        heading: `Final provisions`,
        items: [
          `If any provision is invalid or ineffective, the other provisions remain unaffected; we will replace the invalid provision with one whose meaning comes as close to it as possible.`,
          `These terms are drawn up in Czech and English. In case of conflict, the Czech version prevails, unless mandatory law provides otherwise.`,
          `These terms take effect on ${TERMS_UPDATED.en} and replace the previous version.`,
        ],
      },
    ],
    footer: `Contact: ${LEGAL_CONTACT}. Last updated: ${TERMS_UPDATED.en}.`,
  },
};

// ============================================================================
// OCHRANA OSOBNÍCH ÚDAJŮ
// ============================================================================

export const PRIVACY: LegalDoc = {
  cs: {
    title: `Ochrana osobních údajů`,
    intro: [
      `Tady najdeš, jaké údaje o tobě Kine má, k čemu je potřebuje, komu je svěřuje a jaká máš práva. Správcem údajů je provozovatel Kine; s čímkoliv se obrať na ${LEGAL_CONTACT}.`,
      ...(OPERATOR_CS ? [OPERATOR_CS] : []),
    ],
    sections: [
      {
        heading: `Jaké údaje zpracováváme`,
        items: [
          `Účet: e-mail, uživatelské a zobrazované jméno, datum registrace, souhlas s pravidly. Heslo vidí jen přihlašovací služba (Supabase) a jen v zašifrované podobě - my ho neznáme.`,
          `Profil: profilovka, banner, popis, odkazy, barva kanálu.`,
          `Co na Kine děláš: nahraná videa a Sparks (s názvy, popisy, náhledy a titulky), příspěvky, komentáře, hodnocení, odběry, sledované hry, playlisty, historie sledování a místo, kde ses ve videu zastavil, živá vysílání a zprávy v chatu, hlasy v anketách v chatu (kdo jak hlasoval, nikde neukazujeme), připomenutí vysílání, klipy z vysílání (u klipu je vidět, kdo ho udělal), raidy, oznámení.`,
          `Oznámení na telefon a počítač (jen když si je zapneš): adresa tvého zařízení u push služby prohlížeče (Google, Apple, Mozilla nebo Microsoft), jazyk, typ prohlížeče a co ti má chodit. Obsah oznámení je šifrovaný - push služba ho nepřečte. Vypneš je v Nastavení → Oznámení; zařízení, které oznámení zruší, smažeme.`,
          `Platby: probíhají přes Stripe. My vidíme jen co a kdy jsi zaplatil, stav předplatného a označení zákazníka u Stripe - čísla karet nevidíme. U podpor, Super díky a předplatného kanálu vidí tvůrce tvé jméno, částku a vzkaz; vzkazy u podpor a Super díky jsou veřejné.`,
          `Technické údaje: IP adresa (u zhlédnutí - aby nešlo nafukovat čísla - a kvůli bezpečnosti a omezení zneužití), přibližná země podle IP adresy (jen k zobrazení ceny ve správné měně, neukládá se), typ zařízení a prohlížeče, hlášení chyb (co se pokazilo, na jaké stránce, na jakém zařízení) a nastavení uložená v tvém prohlížeči (vzhled, jazyk, hlasitost).`,
          `Aplikace Kine do PC a Kine Clipper: klipy a nahrávky zůstávají na tvém počítači. Na Kine jde jen to, co nahraješ (nebo automatické nahrávání, pokud si ho zapneš), a to, co je potřeba ke spojení s účtem. Protokol pro řešení potíží zůstává u tebe - pošleš ho jen ty sám.`,
        ],
      },
      {
        heading: `K čemu údaje používáme a proč smíme`,
        items: [
          `Provoz Kine - účet, přehrávání, nahrávání, vysílání, chat, oznámení, předplatné (plnění smlouvy).`,
          `Doporučování videí a hodnocení tvůrců (Rating) - aby ti Kine ukazovalo, co tě zajímá (oprávněný zájem). Nedochází přitom k automatickému rozhodování s právními účinky.`,
          `Bezpečnost, ochrana před spamem, podvody a zneužitím, moderace a automatická kontrola nahoty (oprávněný zájem a plnění právních povinností).`,
          `Platby a účetnictví (plnění smlouvy a právní povinnost).`,
          `Hlášení chyb, abychom je mohli opravit (oprávněný zájem).`,
          `Tvoje údaje nepoužíváme k reklamě a neprodáváme je.`,
        ],
      },
      {
        heading: `Kdo údaje vidí`,
        items: [
          `Ostatní uživatelé vidí to, co je veřejné: jméno, profil, veřejná videa, komentáře, zprávy v chatu, vystavené odznaky.`,
          `Naši dodavatelé, kteří pro nás údaje zpracovávají: Supabase (databáze, přihlášení, obrázky), Cloudflare (ukládání a přehrávání videí a vysílání, automatické titulky, stahování aplikací a ochrana proti botům při registraci a přihlášení - Turnstile, který kvůli tomu vyhodnotí technické údaje o prohlížeči), Vercel (provoz webu), Stripe (platby a výplaty tvůrcům), GitHub (stahování a aktualizace aplikací) a Google (e-mail podpory, když nám napíšeš).`,
          `Push služby prohlížečů (Google, Apple, Mozilla, Microsoft) doručují oznámení na tvoje zařízení, když si je zapneš - dostanou jen šifrovanou zprávu.`,
          `Úřady jen tehdy, když to vyžaduje zákon (například oznámení zneužívání dětí).`,
        ],
      },
      {
        heading: `Přenos mimo EU`,
        paragraphs: [
          `Někteří dodavatelé sídlí nebo zpracovávají údaje mimo Evropskou unii (hlavně v USA). Přenos je chráněný standardními smluvními doložkami EU nebo rámcem EU-USA pro ochranu osobních údajů.`,
        ],
      },
      {
        heading: `Jak dlouho údaje máme`,
        items: [
          `Údaje účtu a tvůj obsah po dobu, kdy máš účet. Po smazání účtu je smažeme (a zrušíme tvá předplatná u Stripe); ze záloh zmizí během několika týdnů.`,
          `Doklady o platbách tak dlouho, jak ukládají účetní a daňové předpisy.`,
          `Hlášení chyb a záznamy zhlédnutí jen po dobu, kterou potřebujeme k jejich účelu.`,
        ],
      },
      {
        heading: `Tvoje práva`,
        items: [
          `Přístup a přenositelnost - v Nastavení → Účet si stáhneš kopii svých údajů (JSON).`,
          `Výmaz - účet i s údaji smažeš v Nastavení → Účet.`,
          `Oprava - profil upravíš kdykoliv v Nastavení.`,
          `Omezení zpracování, námitka proti zpracování na základě oprávněného zájmu a odvolání souhlasu - napiš na ${LEGAL_CONTACT}.`,
          `Stížnost u dozorového úřadu - v Česku Úřad pro ochranu osobních údajů (uoou.gov.cz), jinde úřad tvé země.`,
        ],
      },
      {
        heading: `Cookies a paměť prohlížeče`,
        paragraphs: [
          `Používáme jen technicky nutné cookies a paměť prohlížeče - kvůli přihlášení a zapamatování nastavení (vzhled, jazyk, hlasitost). Žádné reklamní ani sledovací cookies - proto se tě na ně neptáme.`,
        ],
      },
      {
        heading: `Děti`,
        paragraphs: [`Kine není pro děti mladší 13 let. Když zjistíme, že účet patří někomu mladšímu, smažeme ho.`],
      },
      {
        heading: `Zabezpečení`,
        paragraphs: [
          `Spojení je šifrované (HTTPS), hesla se ukládají jen zašifrovaná a k údajům mají přístup jen ti, kdo je nutně potřebují. Žádný systém ale není stoprocentní - kdyby došlo k úniku, který tě ohrožuje, dáme ti vědět.`,
        ],
      },
    ],
    footer: `Tenhle dokument budeme upravovat, když se Kine změní; o podstatných změnách dáme vědět. Kontakt: ${LEGAL_CONTACT}. Poslední změna: ${PRIVACY_UPDATED.cs}.`,
  },
  en: {
    title: `Privacy Policy`,
    intro: [
      `This page explains what data Kine has about you, what it needs it for, who it shares it with and what rights you have. The data controller is the operator of Kine; for anything, contact ${LEGAL_CONTACT}.`,
      ...(OPERATOR_EN ? [OPERATOR_EN] : []),
    ],
    sections: [
      {
        heading: `What data we process`,
        items: [
          `Account: email, username and display name, sign-up date, agreement to the rules. Your password is only seen by the login service (Supabase) and only in encrypted form - we don't know it.`,
          `Profile: profile picture, banner, bio, links, channel colour.`,
          `What you do on Kine: uploaded videos and Sparks (with titles, descriptions, thumbnails and captions), posts, comments, ratings, subscriptions, followed games, playlists, watch history and where you stopped in a video, live streams and chat messages, votes in chat polls (we never show who voted for what), stream reminders, clips from streams (the clip shows who made it), raids, notifications.`,
          `Phone and computer notifications (only if you turn them on): your device's address at your browser's push service (Google, Apple, Mozilla or Microsoft), language, browser type and what you want to be notified about. Notification content is encrypted - the push service can't read it. Turn them off in Settings → Notifications; we delete devices that cancel notifications.`,
          `Payments: handled by Stripe. We only see what you paid and when, your subscription status and your Stripe customer reference - we don't see card numbers. For tips, Super Thanks and channel memberships, the creator sees your name, the amount and your message; messages attached to tips and Super Thanks are public.`,
          `Technical data: IP address (for views - so numbers can't be inflated - and for security and abuse prevention), approximate country based on your IP address (only to show prices in the right currency, not stored), device and browser type, error reports (what went wrong, on which page, on what device) and settings stored in your browser (appearance, language, volume).`,
          `Kine for PC and Kine Clipper: clips and recordings stay on your computer. Only what you upload (or automatic uploading, if you turn it on) and what is needed to connect the app to your account goes to Kine. The troubleshooting log stays with you - only you can send it.`,
        ],
      },
      {
        heading: `What we use data for and why we may`,
        items: [
          `Running Kine - account, playback, uploading, streaming, chat, notifications, subscriptions (performance of a contract).`,
          `Recommending videos and rating creators (Rating) - so Kine shows you what interests you (legitimate interest). This involves no automated decisions with legal effects.`,
          `Security, protection against spam, fraud and abuse, moderation and the automated nudity check (legitimate interest and legal obligations).`,
          `Payments and accounting (performance of a contract and legal obligation).`,
          `Error reports, so we can fix problems (legitimate interest).`,
          `We don't use your data for advertising and we don't sell it.`,
        ],
      },
      {
        heading: `Who sees the data`,
        items: [
          `Other users see what is public: your name, profile, public videos, comments, chat messages, showcased badges.`,
          `Our providers who process data for us: Supabase (database, login, images), Cloudflare (storing and playing videos and streams, automatic captions, app downloads and bot protection at sign-up and login - Turnstile, which evaluates technical browser data for this), Vercel (running the website), Stripe (payments and creator payouts), GitHub (app downloads and updates) and Google (support email, when you write to us).`,
          `Browser push services (Google, Apple, Mozilla, Microsoft) deliver notifications to your devices if you turn them on - they only receive an encrypted message.`,
          `Authorities only when the law requires it (for example reporting child abuse).`,
        ],
      },
      {
        heading: `Transfers outside the EU`,
        paragraphs: [
          `Some providers are based in or process data outside the European Union (mainly in the USA). Such transfers are protected by EU Standard Contractual Clauses or the EU-US Data Privacy Framework.`,
        ],
      },
      {
        heading: `How long we keep data`,
        items: [
          `Account data and your content for as long as you have an account. When you delete your account we delete them (and cancel your Stripe subscriptions); they disappear from backups within a few weeks.`,
          `Payment records for as long as accounting and tax laws require.`,
          `Error reports and view logs only for as long as we need them for their purpose.`,
        ],
      },
      {
        heading: `Your rights`,
        items: [
          `Access and portability - download a copy of your data (JSON) in Settings → Account.`,
          `Erasure - delete your account together with its data in Settings → Account.`,
          `Rectification - edit your profile any time in Settings.`,
          `Restriction of processing, objection to processing based on legitimate interest and withdrawal of consent - write to ${LEGAL_CONTACT}.`,
          `Complaint to a supervisory authority - in the Czech Republic the Office for Personal Data Protection (uoou.gov.cz), elsewhere the authority in your country.`,
        ],
      },
      {
        heading: `Cookies and browser storage`,
        paragraphs: [
          `We only use technically necessary cookies and browser storage - to keep you logged in and remember your settings (appearance, language, volume). No advertising or tracking cookies - which is why we don't ask you about them.`,
        ],
      },
      {
        heading: `Children`,
        paragraphs: [`Kine is not for children under 13. If we find out that an account belongs to someone younger, we delete it.`],
      },
      {
        heading: `Security`,
        paragraphs: [
          `Connections are encrypted (HTTPS), passwords are only stored encrypted and only people who really need it have access to data. No system is perfect, though - if a breach ever puts you at risk, we will tell you.`,
        ],
      },
    ],
    footer: `We will update this document when Kine changes and will let you know about significant changes. Contact: ${LEGAL_CONTACT}. Last updated: ${PRIVACY_UPDATED.en}.`,
  },
};
