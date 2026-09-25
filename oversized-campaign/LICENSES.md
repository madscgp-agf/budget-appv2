# Assets og licenser

Alt, der vises eller afspilles i spillet, er enten lavet i koden til dette projekt eller kommer fra open source-pakker med licenser, der tillader kommerciel brug.

## Grafik, lyd og modeller

| Asset | Kilde | Licens / status |
|---|---|---|
| Atlet (krop, tøj, sko, hue) | Bygget i kode: `client/game/athlete.js` | Eget arbejde. **Midlertidigt asset**, se nedenfor |
| Bænk, stativ, J-kroge, sikkerhedsarme, vægtstang, vægtskiver, håndvægtsstativ, rum | Bygget i kode: `client/game/scene.js` | Eget arbejde |
| Teksturer (gummigulv, beton, riflet stang, stof, skivetryk, huller i stativ, "OVERSIZED"-skilt, tryk på t-shirt) | Tegnet på canvas i `client/game/textures.js` | Eget arbejde. Ingen billedfiler |
| Lyde (vejrtrækning, stønnen, klirren, bip) | Syntetiseret med Web Audio i `client/game/audio.js` | Eget arbejde. Ingen lydfiler |
| Skrifttyper | Systemskrifter (Helvetica Neue / Arial / system-ui) | Ingen webfonte indlæses |
| Ikoner (lyd, bevægelse, luk, profil) | Inline SVG i `client/game/main.js` | Eget arbejde |

"OVERSIZED" og "Oversized Studios" er brandets egne navne. Her er de kun sat med en systemskrift – der er ikke brugt noget logo.

### Midlertidig atlet

Vi havde ingen rigget menneskemodel med kommerciel licens til rådighed, så atleten er bygget af drejede former (lathe-geometri) med realistiske proportioner (ca. 1,80 m) og bevæges med IK, så skuldre, albuer og håndled følger stangen. Figuren er troværdig nok til at spille med, men den er ikke scannet eller skulptureret og har ingen ansigtsmimik.

Sådan skifter du til en rigget GLB-model (Mixamo-knoglenavne understøttes): se "Udskift atleten" i README. Når du vælger en model, skal du sikre dig, at licensen tillader **kommerciel brug i en webbutik**, og at modellen må **distribueres i en browser** (GLB-filen kan hentes af alle besøgende). Skriv modellen, kilden og licensen ind i tabellen ovenfor.

## Software (npm-afhængigheder)

| Pakke | Version | Licens |
|---|---|---|
| three | 0.186.x | MIT |
| express | 5.x | MIT |
| better-sqlite3 | 12.x | MIT |
| zod | 4.x | MIT |
| nodemailer | 10.x | MIT-0 |
| cookie-parser | 1.x | MIT |
| dotenv | 17.x | BSD-2-Clause |
| esbuild (byggeværktøj) | 0.28.x | MIT |

Transitive afhængigheder (`npx license-checker --summary`): MIT 94, ISC 7, Apache-2.0 2, BSD-3-Clause 2, BSD-2-Clause 1, MIT OR WTFPL 1, (BSD-2-Clause OR MIT OR Apache-2.0) 1, MIT-0 1. Der er ingen copyleft-licenser (GPL, AGPL). Kør kommandoen igen, når afhængighederne opdateres.

Den bundtede spilfil (`extensions/oversized-game/assets/oversized-*.js`) indeholder three.js. MIT-licensen kræver, at copyright-meddelelsen følger med ved distribution. Kilden og licensen står her og i `node_modules/three/LICENSE`. Byggetrinnet fjerner kommentarer, så læg `THIRD_PARTY_NOTICES` eller et link til denne fil på butikkens side med juridiske oplysninger, hvis I vil gøre det helt formelt.

## Shopify

App Bridge (`https://cdn.shopify.com/shopifycloud/app-bridge.js`) indlæses kun i den indlejrede administration fra Shopifys CDN. Den er omfattet af Shopifys API- og partnervilkår, ikke af en open source-licens.
