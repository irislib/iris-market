Iris Maps place catalog reader

Adapted from Iris Maps 0.1.14, source commit `1f691f33f2e3b572e52d0cdafda2350c26ba44e2`, whose package declares `MIT`.
Source: https://git.iris.to/#/npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm/iris-maps

The pure reader, normalization and bounded asynchronous cache are reused. Account stores, mutable reference resolution and publishing are excluded. Autocomplete bounds the candidate scan to at least 24 records rather than the full Maps app’s 80, and returns at most eight suggestions. Catalog content is pinned by the searchRoot CID in manifest.json; every downloaded block is SHA-256 verified by Market's read-only bounded map cache. No query or device coordinate is sent to a geocoder.

Catalog attribution: © OpenStreetMap contributors (ODbL), OpenMapTiles, OpenFreeMap; administrative context: Overture Maps Foundation, OpenStreetMap contributors, geoBoundaries. Bundled city/country labels derive from Natural Earth (public domain), reused from Iris Maps.

SPDX-License-Identifier: MIT

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

Original source SHA-256:
- mapSearchIndex.ts: `ae5d93e5c3904caf812601f755e93b82d911bf3fb6d959c1bcc6701fd660e499`
- mapSearchText.ts: `55fa0f74d9cfbb7d8eac6225a4c009bd83936bd6471ce16b5b3abf9897fbf32f`
- asyncCache.ts: `03b006ebee38d8e10e629356f643bdc2b22aecbd1cc81f7eb31e64e24702fe05`
