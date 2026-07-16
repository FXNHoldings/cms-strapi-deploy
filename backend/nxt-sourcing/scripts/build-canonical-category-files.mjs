#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT_DIR = join(ROOT, 'data', 'canonical-products');

const COMMON_EXCLUDE = ['refurbished', 'renewed', 'used'];

const CONFIGS = [
  {
    file: 'Video_Doorbells.json',
    category: 'Video Doorbells',
    globalExcludeTerms: [
      'chime',
      'chime pro',
      'wedge kit',
      'corner kit',
      'mount',
      'wall mount',
      'bracket',
      'transformer',
      'subscription',
      'cloud storage',
      'battery pack',
      'solar panel',
      'power adapter',
      'cable',
      'faceplate',
      'skin',
      'cover',
      'replacement',
      'for parts',
      'parts only',
      'dummy',
      'display model',
    ],
    searchSuffix: 'video doorbell',
    familyLabel: 'Doorbells',
    variantsToSplitLater: ['color', 'powerType', 'condition', 'region'],
    products: `
Ring Battery Doorbell
Ring Video Doorbell Wired
Ring Battery Doorbell Plus (2nd Gen)
Ring Battery Doorbell Pro (2nd Gen)
Ring Wired Doorbell Plus
Ring Wired Doorbell Pro (3rd Gen)
Blink Video Doorbell
Blink Battery Doorbell 2K+
Blink Wired Doorbell 2K+
Google Nest Doorbell (Battery)
Google Nest Doorbell (Wired, 3rd Gen)
Eufy Video Doorbell E340
Eufy Video Doorbell Dual S330
Eufy Video Doorbell C31
Eufy Video Doorbell C30
Eufy Video Doorbell S220
Arlo Video Doorbell 2K (2nd Gen)
Arlo Essential Video Doorbell Wire-Free
TP-Link Tapo D225
TP-Link Tapo D230S1
TP-Link Tapo TD25
Wyze Battery Video Doorbell
Wyze Duo Cam Battery Doorbell
Reolink Video Doorbell WiFi
Reolink Video Doorbell PoE
Aqara Doorbell Camera Hub G4
Aqara Doorbell Camera Hub G410
EZVIZ EP3x Pro
SimpliSafe Video Doorbell Pro
SwannBuddy4K Wireless Video Doorbell
`.trim(),
  },
  {
    file: 'smart_door_locks.json',
    category: 'Smart Door Locks',
    globalExcludeTerms: [
      'keypad only',
      'cylinder',
      'keys only',
      'mounting plate',
      'adapter',
      'bridge',
      'hub only',
      'battery pack',
      'cover',
      'replacement',
      'for parts',
      'parts only',
      'dummy',
      'display model',
    ],
    searchSuffix: 'smart lock',
    familyLabel: 'Smart Locks',
    variantsToSplitLater: ['color', 'finish', 'connectivity', 'condition', 'region'],
    products: `
Schlage Encode Plus Smart WiFi Deadbolt
Schlage Encode Smart WiFi Deadbolt
Schlage Encode Smart WiFi Lever
Schlage Connect Smart Deadbolt
Yale Assure Lock 2 Touch
Yale Assure Lock 2 Plus
Yale Assure Lock 2 Key-Free Touchscreen
Yale Approach Lock with Wi-Fi
August Wi-Fi Smart Lock (4th Gen)
August Smart Lock Pro (3rd Gen)
Kwikset Halo Wi-Fi Smart Lock
Kwikset Halo Touch
Kwikset Halo Select
Kwikset Premis
Eufy Smart Lock C220
Eufy Smart Lock C210
Eufy Smart Lock E30
Eufy Video Smart Lock E330
Ultraloq U-Bolt Pro WiFi
Ultraloq Bolt Fingerprint
Ultraloq Bolt NFC
Lockly Visage Zeno Series
Lockly Secure Pro
Lockly Flex Touch Pro
Aqara Smart Lock U100
Aqara Smart Lock U200
SwitchBot Lock Pro
SwitchBot Lock Ultra Vision Combo
Wyze Lock Bolt v2
Level Lock+
`.trim(),
  },
  {
    file: 'smart_plugs.json',
    category: 'Smart Plugs',
    globalExcludeTerms: [
      'extension cord',
      'power strip',
      'outdoor cable',
      'hub only',
      'remote only',
      'cover',
      'replacement',
      'for parts',
      'parts only',
      'dummy',
      'display model',
    ],
    searchSuffix: 'smart plug',
    familyLabel: 'Plugs',
    variantsToSplitLater: ['color', 'packSize', 'condition', 'region'],
    products: `
Amazon Smart Plug
Amazon Basics Smart Plug
TP-Link Kasa Smart Plug Ultra Mini EP10
TP-Link Kasa Smart Wi-Fi Plug Mini EP25
TP-Link Kasa Smart Plug Mini HS103
TP-Link Kasa Smart Plug Mini HS105
TP-Link Kasa Smart Wi-Fi Plug HS100
TP-Link Kasa Smart Plug with Energy Monitoring KP115
TP-Link Kasa Matter Smart Plug KP125M
TP-Link Kasa Outdoor Smart Plug EP40
TP-Link Kasa Outdoor Smart Plug KP400
TP-Link Tapo Mini Smart Wi-Fi Plug P100
TP-Link Tapo Mini Smart Wi-Fi Plug P105
TP-Link Tapo Smart Wi-Fi Plug P110
TP-Link Tapo Smart Wi-Fi Plug P115
TP-Link Tapo Matter Smart Plug P125M
TP-Link Tapo Outdoor Smart Plug TP25
Govee Smart Plug H5080
Govee Smart Plug H5083
Govee Smart Plug Pro H5086
Meross Smart Wi-Fi Plug Mini MSS110
Meross Smart Wi-Fi Plug Mini MSS115
Meross Outdoor Smart Plug MSS620
Wemo Mini Smart Plug
Wemo Smart Plug with Thread
Wyze Plug
Wyze Plug Outdoor
Philips Hue Smart Plug
Eve Energy Smart Plug
GE Cync Indoor Smart Plug
`.trim(),
  },
];

function familyKey(name, familyLabel) {
  if (name.startsWith('Amazon Basics')) return { brand: 'Amazon', family: 'Amazon Basics Plugs' };
  if (name.startsWith('Amazon ')) return { brand: 'Amazon', family: `Amazon ${familyLabel}` };
  if (name.startsWith('Google ')) return { brand: 'Google', family: `Google ${familyLabel}` };
  if (name.startsWith('TP-Link Tapo')) return { brand: 'TP-Link', family: `Tapo ${familyLabel}` };
  if (name.startsWith('TP-Link Kasa')) return { brand: 'TP-Link', family: `Kasa ${familyLabel}` };
  if (name.startsWith('GE Cync')) return { brand: 'GE', family: `Cync ${familyLabel}` };
  if (name.startsWith('Philips Hue')) return { brand: 'Philips', family: `Hue ${familyLabel}` };
  if (name.startsWith('Eve Energy')) return { brand: 'Eve', family: `Eve ${familyLabel}` };

  const brand = name.split(/\s+/)[0];
  return { brand, family: `${brand} ${familyLabel}` };
}

function requiredTerms(name) {
  return [
    ...new Set(
      name
        .toLowerCase()
        .replace(/[()+]/g, ' ')
        .replace(/[,/]/g, ' ')
        .split(/\s+/)
        .map((term) => term.replace(/[^\w+#-]/g, ''))
        .filter((term) => term.length > 1),
    ),
  ];
}

function variantFor(name, config) {
  const excludeTerms = [...config.globalExcludeTerms, ...COMMON_EXCLUDE];
  return {
    canonicalName: name,
    model: name,
    identifierStatus: 'needs_verification',
    identifiers: {},
    requiredTerms: requiredTerms(name),
    excludeTerms,
    searchQueries: [name, `${name} ${config.searchSuffix}`],
    variantsToSplitLater: config.variantsToSplitLater,
  };
}

function buildFile(config) {
  const familiesMap = new Map();

  for (const name of config.products.split('\n').map((line) => line.trim()).filter(Boolean)) {
    const { brand, family } = familyKey(name, config.familyLabel);
    const key = `${brand}::${family}`;
    if (!familiesMap.has(key)) {
      familiesMap.set(key, {
        brand,
        family,
        category: config.category,
        sourceStatus: 'seed',
        variants: [],
      });
    }
    familiesMap.get(key).variants.push(variantFor(name, config));
  }

  const families = [...familiesMap.values()].sort((a, b) => a.family.localeCompare(b.family));
  for (const family of families) {
    family.variants.sort((a, b) => a.canonicalName.localeCompare(b.canonicalName, 'en', { numeric: true }));
  }

  return {
    schemaVersion: 1,
    category: config.category,
    defaultCountry: 'US',
    defaultCurrency: 'USD',
    globalExcludeTerms: config.globalExcludeTerms,
    families,
  };
}

for (const config of CONFIGS) {
  const data = buildFile(config);
  const outPath = join(OUT_DIR, config.file);
  writeFileSync(outPath, `${JSON.stringify(data, null, 2)}\n`);
  const variantCount = data.families.reduce((sum, family) => sum + family.variants.length, 0);
  console.log(`${config.file}: ${variantCount} variants across ${data.families.length} families`);
}
