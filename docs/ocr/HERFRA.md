# Hvor filerne kommer fra

Kvitteringslæsningen bruger Tesseract. Filerne ligger her i stedet for på et
CDN, så appen også virker uden net, når den først er installeret.

| Fil | Kilde | Version |
|---|---|---|
| `tesseract.min.js`, `worker.min.js` | npm `tesseract.js` | 5.1.1 |
| `tesseract-core-simd-lstm.*` | npm `tesseract.js-core` | 5.1.1 |
| `dan.traineddata.gz` | github.com/naptha/tessdata, `4.0.0_fast` | — |

Kun SIMD-udgaven af kernen ligger her. Alle iPhones fra iOS 16.4 og
nyere kan køre den. Kan en telefon ikke, henter appen ingenting og falder
tilbage til at man taster beløbet selv — den går ikke i stykker.

Skal de opdateres:

    npm pack tesseract.js@5 tesseract.js-core@5
    curl -O https://raw.githubusercontent.com/naptha/tessdata/gh-pages/4.0.0_fast/dan.traineddata.gz
