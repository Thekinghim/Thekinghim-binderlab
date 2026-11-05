# Licenser för produktionsberoenden

Genererad med `node scripts/granskning/licenser.mjs` ur `package-lock.json` och paketens `package.json` i `node_modules` (5 nov. 2026, i byggmiljön). Kör om efter varje ändring av beroendena. Sammanfattning och bedömning: [agande.md](agande.md).

Produktionsberoenden: 499 paket (430 installerade här, resten plattformsbinärer för andra plattformar).

| Licens                                   | Paket |
| ---------------------------------------- | ----- |
| MIT                                      | 367   |
| ISC                                      | 40    |
| Apache-2.0                               | 38    |
| BSD-3-Clause                             | 15    |
| LGPL-3.0-or-later                        | 10    |
| 0BSD                                     | 6     |
| BlueOak-1.0.0                            | 5     |
| Apache-2.0 AND LGPL-3.0-or-later         | 3     |
| Unlicense                                | 3     |
| (MIT AND Zlib)                           | 1     |
| (MIT OR CC0-1.0)                         | 1     |
| (MIT OR GPL-3.0-or-later)                | 1     |
| Apache-2.0 AND LGPL-3.0-or-later AND MIT | 1     |
| BSD-2-Clause                             | 1     |
| CC-BY-4.0                                | 1     |
| FSL-1.1-Apache-2.0                       | 1     |
| MIT-0                                    | 1     |
| MIT/X11                                  | 1     |
| MPL-2.0                                  | 1     |
| SAKNAS                                   | 1     |
| SIL OPEN FONT LICENSE                    | 1     |

Flaggade (copyleft eller ingen licens):

| Paket                                | Version | Licens                                   | Flagga       | Installerat här |
| ------------------------------------ | ------- | ---------------------------------------- | ------------ | --------------- |
| `@img/sharp-libvips-darwin-arm64`    | 1.3.4   | LGPL-3.0-or-later                        | copyleft     | nej             |
| `@img/sharp-libvips-darwin-x64`      | 1.3.4   | LGPL-3.0-or-later                        | copyleft     | nej             |
| `@img/sharp-libvips-linux-arm`       | 1.3.4   | LGPL-3.0-or-later                        | copyleft     | nej             |
| `@img/sharp-libvips-linux-arm64`     | 1.3.4   | LGPL-3.0-or-later                        | copyleft     | nej             |
| `@img/sharp-libvips-linux-ppc64`     | 1.3.4   | LGPL-3.0-or-later                        | copyleft     | nej             |
| `@img/sharp-libvips-linux-riscv64`   | 1.3.4   | LGPL-3.0-or-later                        | copyleft     | nej             |
| `@img/sharp-libvips-linux-s390x`     | 1.3.4   | LGPL-3.0-or-later                        | copyleft     | nej             |
| `@img/sharp-libvips-linux-x64`       | 1.3.4   | LGPL-3.0-or-later                        | copyleft     | ja              |
| `@img/sharp-libvips-linuxmusl-arm64` | 1.3.4   | LGPL-3.0-or-later                        | copyleft     | nej             |
| `@img/sharp-libvips-linuxmusl-x64`   | 1.3.4   | LGPL-3.0-or-later                        | copyleft     | ja              |
| `@img/sharp-wasm32`                  | 0.35.5  | Apache-2.0 AND LGPL-3.0-or-later AND MIT | copyleft     | ja              |
| `@img/sharp-win32-arm64`             | 0.35.5  | Apache-2.0 AND LGPL-3.0-or-later         | copyleft     | nej             |
| `@img/sharp-win32-ia32`              | 0.35.5  | Apache-2.0 AND LGPL-3.0-or-later         | copyleft     | nej             |
| `@img/sharp-win32-x64`               | 0.35.5  | Apache-2.0 AND LGPL-3.0-or-later         | copyleft     | nej             |
| `buffers`                            | 0.1.1   | SAKNAS                                   | ingen licens | ja              |
| `jszip`                              | 3.10.2  | (MIT OR GPL-3.0-or-later)                | copyleft     | ja              |
| `web-push`                           | 3.6.7   | MPL-2.0                                  | copyleft     | ja              |

Alla paket:

| Paket                                      | Version      | Licens                                   |
| ------------------------------------------ | ------------ | ---------------------------------------- |
| `@anthropic-ai/sdk`                        | 1.3.0        | Apache-2.0                               |
| `@babel/runtime`                           | 7.29.10      | MIT                                      |
| `@emnapi/runtime`                          | 1.11.3       | MIT                                      |
| `@fast-csv/format`                         | 4.3.5        | MIT                                      |
| `@fast-csv/parse`                          | 4.3.6        | MIT                                      |
| `@grpc/grpc-js`                            | 1.14.6       | Apache-2.0                               |
| `@grpc/proto-loader`                       | 0.8.1        | Apache-2.0                               |
| `@img/colour`                              | 1.1.0        | MIT                                      |
| `@img/sharp-darwin-arm64`                  | 0.35.5       | Apache-2.0                               |
| `@img/sharp-darwin-x64`                    | 0.35.5       | Apache-2.0                               |
| `@img/sharp-freebsd-wasm32`                | 0.35.5       | Apache-2.0                               |
| `@img/sharp-libvips-darwin-arm64`          | 1.3.4        | LGPL-3.0-or-later                        |
| `@img/sharp-libvips-darwin-x64`            | 1.3.4        | LGPL-3.0-or-later                        |
| `@img/sharp-libvips-linux-arm`             | 1.3.4        | LGPL-3.0-or-later                        |
| `@img/sharp-libvips-linux-arm64`           | 1.3.4        | LGPL-3.0-or-later                        |
| `@img/sharp-libvips-linux-ppc64`           | 1.3.4        | LGPL-3.0-or-later                        |
| `@img/sharp-libvips-linux-riscv64`         | 1.3.4        | LGPL-3.0-or-later                        |
| `@img/sharp-libvips-linux-s390x`           | 1.3.4        | LGPL-3.0-or-later                        |
| `@img/sharp-libvips-linux-x64`             | 1.3.4        | LGPL-3.0-or-later                        |
| `@img/sharp-libvips-linuxmusl-arm64`       | 1.3.4        | LGPL-3.0-or-later                        |
| `@img/sharp-libvips-linuxmusl-x64`         | 1.3.4        | LGPL-3.0-or-later                        |
| `@img/sharp-linux-arm`                     | 0.35.5       | Apache-2.0                               |
| `@img/sharp-linux-arm64`                   | 0.35.5       | Apache-2.0                               |
| `@img/sharp-linux-ppc64`                   | 0.35.5       | Apache-2.0                               |
| `@img/sharp-linux-riscv64`                 | 0.35.5       | Apache-2.0                               |
| `@img/sharp-linux-s390x`                   | 0.35.5       | Apache-2.0                               |
| `@img/sharp-linux-x64`                     | 0.35.5       | Apache-2.0                               |
| `@img/sharp-linuxmusl-arm64`               | 0.35.5       | Apache-2.0                               |
| `@img/sharp-linuxmusl-x64`                 | 0.35.5       | Apache-2.0                               |
| `@img/sharp-wasm32`                        | 0.35.5       | Apache-2.0 AND LGPL-3.0-or-later AND MIT |
| `@img/sharp-webcontainers-wasm32`          | 0.35.5       | Apache-2.0                               |
| `@img/sharp-win32-arm64`                   | 0.35.5       | Apache-2.0 AND LGPL-3.0-or-later         |
| `@img/sharp-win32-ia32`                    | 0.35.5       | Apache-2.0 AND LGPL-3.0-or-later         |
| `@img/sharp-win32-x64`                     | 0.35.5       | Apache-2.0 AND LGPL-3.0-or-later         |
| `@jridgewell/sourcemap-codec`              | 1.6.0        | MIT                                      |
| `@js-sdsl/ordered-map`                     | 4.4.2        | MIT                                      |
| `@napi-rs/lzma-linux-x64-gnu`              | 1.5.1        | MIT                                      |
| `@next/env`                                | 16.4.3       | MIT                                      |
| `@next/swc-darwin-arm64`                   | 16.4.3       | MIT                                      |
| `@next/swc-darwin-x64`                     | 16.4.3       | MIT                                      |
| `@next/swc-linux-arm64-gnu`                | 16.4.3       | MIT                                      |
| `@next/swc-linux-arm64-musl`               | 16.4.3       | MIT                                      |
| `@next/swc-linux-x64-gnu`                  | 16.4.3       | MIT                                      |
| `@next/swc-linux-x64-musl`                 | 16.4.3       | MIT                                      |
| `@next/swc-win32-arm64-msvc`               | 16.4.3       | MIT                                      |
| `@next/swc-win32-x64-msvc`                 | 16.4.3       | MIT                                      |
| `@opentelemetry/api`                       | 1.10.0       | Apache-2.0                               |
| `@oxc-parser/binding-android-arm-eabi`     | 0.152.0      | MIT                                      |
| `@oxc-parser/binding-android-arm64`        | 0.152.0      | MIT                                      |
| `@oxc-parser/binding-darwin-arm64`         | 0.152.0      | MIT                                      |
| `@oxc-parser/binding-darwin-x64`           | 0.152.0      | MIT                                      |
| `@oxc-parser/binding-freebsd-x64`          | 0.152.0      | MIT                                      |
| `@oxc-parser/binding-linux-arm-gnueabihf`  | 0.152.0      | MIT                                      |
| `@oxc-parser/binding-linux-arm-musleabihf` | 0.152.0      | MIT                                      |
| `@oxc-parser/binding-linux-arm64-gnu`      | 0.152.0      | MIT                                      |
| `@oxc-parser/binding-linux-arm64-musl`     | 0.152.0      | MIT                                      |
| `@oxc-parser/binding-linux-ppc64-gnu`      | 0.152.0      | MIT                                      |
| `@oxc-parser/binding-linux-riscv64-gnu`    | 0.152.0      | MIT                                      |
| `@oxc-parser/binding-linux-riscv64-musl`   | 0.152.0      | MIT                                      |
| `@oxc-parser/binding-linux-s390x-gnu`      | 0.152.0      | MIT                                      |
| `@oxc-parser/binding-linux-x64-gnu`        | 0.152.0      | MIT                                      |
| `@oxc-parser/binding-linux-x64-musl`       | 0.152.0      | MIT                                      |
| `@oxc-parser/binding-openharmony-arm64`    | 0.152.0      | MIT                                      |
| `@oxc-parser/binding-win32-arm64-msvc`     | 0.152.0      | MIT                                      |
| `@oxc-parser/binding-win32-ia32-msvc`      | 0.152.0      | MIT                                      |
| `@oxc-parser/binding-win32-x64-msvc`       | 0.152.0      | MIT                                      |
| `@oxc-project/types`                       | 0.152.0      | MIT                                      |
| `@protobufjs/aspromise`                    | 1.1.2        | BSD-3-Clause                             |
| `@protobufjs/base64`                       | 1.1.2        | BSD-3-Clause                             |
| `@protobufjs/codegen`                      | 2.0.5        | BSD-3-Clause                             |
| `@protobufjs/eventemitter`                 | 1.1.1        | BSD-3-Clause                             |
| `@protobufjs/fetch`                        | 1.1.1        | BSD-3-Clause                             |
| `@protobufjs/float`                        | 1.0.2        | BSD-3-Clause                             |
| `@protobufjs/path`                         | 1.1.2        | BSD-3-Clause                             |
| `@protobufjs/pool`                         | 1.1.0        | BSD-3-Clause                             |
| `@protobufjs/utf8`                         | 1.1.2        | BSD-3-Clause                             |
| `@puppeteer/browsers`                      | 3.2.6        | Apache-2.0                               |
| `@rollup/plugin-commonjs`                  | 28.0.1       | MIT                                      |
| `@rollup/pluginutils`                      | 5.5.1        | MIT                                      |
| `@rollup/rollup-android-arm-eabi`          | 4.67.4       | MIT                                      |
| `@rollup/rollup-android-arm64`             | 4.67.4       | MIT                                      |
| `@rollup/rollup-android-x64`               | 4.67.4       | MIT                                      |
| `@rollup/rollup-darwin-arm64`              | 4.67.4       | MIT                                      |
| `@rollup/rollup-darwin-x64`                | 4.67.4       | MIT                                      |
| `@rollup/rollup-freebsd-arm64`             | 4.67.4       | MIT                                      |
| `@rollup/rollup-freebsd-x64`               | 4.67.4       | MIT                                      |
| `@rollup/rollup-linux-arm-gnueabihf`       | 4.67.4       | MIT                                      |
| `@rollup/rollup-linux-arm-musleabihf`      | 4.67.4       | MIT                                      |
| `@rollup/rollup-linux-arm64-gnu`           | 4.67.4       | MIT                                      |
| `@rollup/rollup-linux-arm64-musl`          | 4.67.4       | MIT                                      |
| `@rollup/rollup-linux-loong64-gnu`         | 4.67.4       | MIT                                      |
| `@rollup/rollup-linux-loong64-musl`        | 4.67.4       | MIT                                      |
| `@rollup/rollup-linux-ppc64-gnu`           | 4.67.4       | MIT                                      |
| `@rollup/rollup-linux-ppc64-musl`          | 4.67.4       | MIT                                      |
| `@rollup/rollup-linux-riscv64-gnu`         | 4.67.4       | MIT                                      |
| `@rollup/rollup-linux-riscv64-musl`        | 4.67.4       | MIT                                      |
| `@rollup/rollup-linux-s390x-gnu`           | 4.67.4       | MIT                                      |
| `@rollup/rollup-linux-x64-gnu`             | 4.67.4       | MIT                                      |
| `@rollup/rollup-linux-x64-musl`            | 4.67.4       | MIT                                      |
| `@rollup/rollup-openbsd-x64`               | 4.67.4       | MIT                                      |
| `@rollup/rollup-openharmony-arm64`         | 4.67.4       | MIT                                      |
| `@rollup/rollup-win32-arm64-msvc`          | 4.67.4       | MIT                                      |
| `@rollup/rollup-win32-ia32-msvc`           | 4.67.4       | MIT                                      |
| `@rollup/rollup-win32-x64-gnu`             | 4.67.4       | MIT                                      |
| `@rollup/rollup-win32-x64-msvc`            | 4.67.4       | MIT                                      |
| `@sentry/browser`                          | 11.10.0      | MIT                                      |
| `@sentry/browser-utils`                    | 11.10.0      | MIT                                      |
| `@sentry/bundler-plugins`                  | 11.10.0      | MIT                                      |
| `@sentry/cloudflare`                       | 11.10.0      | MIT                                      |
| `@sentry/conventions`                      | 0.29.0       | MIT                                      |
| `@sentry/core`                             | 11.10.0      | MIT                                      |
| `@sentry/feedback`                         | 11.10.0      | MIT                                      |
| `@sentry/nextjs`                           | 11.10.0      | MIT                                      |
| `@sentry/node`                             | 11.10.0      | MIT                                      |
| `@sentry/opentelemetry`                    | 11.10.0      | MIT                                      |
| `@sentry/react`                            | 11.10.0      | MIT                                      |
| `@sentry/replay`                           | 11.10.0      | MIT                                      |
| `@sentry/replay-canvas`                    | 11.10.0      | MIT                                      |
| `@sentry/server-runtime-injection`         | 11.10.0      | MIT                                      |
| `@sentry/server-utils`                     | 11.10.0      | MIT                                      |
| `@sentry/vercel-edge`                      | 11.10.0      | MIT                                      |
| `@sparticuz/chromium`                      | 153.0.0      | MIT                                      |
| `@stablelib/base64`                        | 1.0.1        | MIT                                      |
| `@supabase/auth-js`                        | 2.118.0      | MIT                                      |
| `@supabase/functions-js`                   | 2.118.0      | MIT                                      |
| `@supabase/phoenix`                        | 0.4.5        | MIT                                      |
| `@supabase/postgrest-js`                   | 2.118.0      | MIT                                      |
| `@supabase/realtime-js`                    | 2.118.0      | MIT                                      |
| `@supabase/ssr`                            | 0.12.7       | MIT                                      |
| `@supabase/storage-js`                     | 2.118.0      | MIT                                      |
| `@supabase/supabase-js`                    | 2.118.0      | MIT                                      |
| `@swc/helpers`                             | 0.5.23       | Apache-2.0                               |
| `@types/estree`                            | 1.0.10       | MIT                                      |
| `@types/node`                              | 14.18.63     | MIT                                      |
| `@types/node`                              | 14.18.63     | MIT                                      |
| `@types/node`                              | 26.6.6       | MIT                                      |
| `agent-base`                               | 7.1.4        | MIT                                      |
| `ansi-regex`                               | 5.0.1        | MIT                                      |
| `ansi-regex`                               | 5.0.1        | MIT                                      |
| `ansi-regex`                               | 6.5.0        | MIT                                      |
| `ansi-styles`                              | 4.3.0        | MIT                                      |
| `ansi-styles`                              | 6.2.3        | MIT                                      |
| `archiver`                                 | 5.3.2        | MIT                                      |
| `archiver-utils`                           | 2.1.0        | MIT                                      |
| `archiver-utils`                           | 3.0.4        | MIT                                      |
| `array-buffer-byte-length`                 | 1.0.2        | MIT                                      |
| `arraybuffer.prototype.slice`              | 1.0.4        | MIT                                      |
| `asn1.js`                                  | 5.4.1        | MIT                                      |
| `async`                                    | 3.2.6        | MIT                                      |
| `async-function`                           | 1.0.0        | MIT                                      |
| `available-typed-arrays`                   | 1.0.7        | MIT                                      |
| `b4a`                                      | 1.9.0        | Apache-2.0                               |
| `balanced-match`                           | 1.0.2        | MIT                                      |
| `balanced-match`                           | 4.0.4        | MIT                                      |
| `bare-events`                              | 2.9.2        | Apache-2.0                               |
| `bare-fs`                                  | 4.8.4        | Apache-2.0                               |
| `bare-path`                                | 3.1.2        | Apache-2.0                               |
| `bare-stream`                              | 2.13.4       | Apache-2.0                               |
| `bare-url`                                 | 2.5.5        | Apache-2.0                               |
| `base64-js`                                | 1.5.1        | MIT                                      |
| `baseline-browser-mapping`                 | 2.11.34      | Apache-2.0                               |
| `big-integer`                              | 1.6.52       | Unlicense                                |
| `binary`                                   | 0.3.0        | MIT                                      |
| `bl`                                       | 4.1.0        | MIT                                      |
| `bluebird`                                 | 3.4.7        | MIT                                      |
| `bn.js`                                    | 4.12.5       | MIT                                      |
| `brace-expansion`                          | 1.1.21       | MIT                                      |
| `brace-expansion`                          | 2.1.7        | MIT                                      |
| `brace-expansion`                          | 5.0.12       | MIT                                      |
| `buffer`                                   | 5.7.1        | MIT                                      |
| `buffer-crc32`                             | 0.2.13       | MIT                                      |
| `buffer-equal-constant-time`               | 1.0.1        | BSD-3-Clause                             |
| `buffer-indexof-polyfill`                  | 1.0.2        | MIT                                      |
| `buffers`                                  | 0.1.1        | SAKNAS                                   |
| `call-bind`                                | 1.0.9        | MIT                                      |
| `call-bind-apply-helpers`                  | 1.0.2        | MIT                                      |
| `call-bound`                               | 1.0.4        | MIT                                      |
| `camelcase`                                | 5.3.1        | MIT                                      |
| `caniuse-lite`                             | 1.0.30001820 | CC-BY-4.0                                |
| `chainsaw`                                 | 0.1.0        | MIT/X11                                  |
| `chromium-bidi`                            | 157.0.8090-0 | Apache-2.0                               |
| `client-only`                              | 0.0.1        | MIT                                      |
| `cliui`                                    | 6.0.0        | ISC                                      |
| `cliui`                                    | 8.0.1        | ISC                                      |
| `cliui`                                    | 9.0.1        | ISC                                      |
| `color-convert`                            | 2.0.1        | MIT                                      |
| `color-name`                               | 1.1.4        | MIT                                      |
| `commondir`                                | 1.0.1        | MIT                                      |
| `compress-commons`                         | 4.1.2        | MIT                                      |
| `concat-map`                               | 0.0.1        | MIT                                      |
| `cookie`                                   | 1.1.1        | MIT                                      |
| `core-util-is`                             | 1.0.3        | MIT                                      |
| `crc-32`                                   | 1.2.2        | Apache-2.0                               |
| `crc32-stream`                             | 4.0.3        | MIT                                      |
| `d3-array`                                 | 3.2.4        | ISC                                      |
| `d3-color`                                 | 3.1.0        | ISC                                      |
| `d3-format`                                | 3.1.2        | ISC                                      |
| `d3-interpolate`                           | 3.0.1        | ISC                                      |
| `d3-path`                                  | 3.1.0        | ISC                                      |
| `d3-scale`                                 | 4.0.2        | ISC                                      |
| `d3-shape`                                 | 3.2.0        | ISC                                      |
| `d3-time`                                  | 3.1.0        | ISC                                      |
| `d3-time-format`                           | 4.1.0        | ISC                                      |
| `data-view-buffer`                         | 1.0.2        | MIT                                      |
| `data-view-byte-length`                    | 1.0.2        | MIT                                      |
| `data-view-byte-offset`                    | 1.0.1        | MIT                                      |
| `dayjs`                                    | 1.11.23      | MIT                                      |
| `debug`                                    | 4.4.3        | MIT                                      |
| `decamelize`                               | 1.2.0        | MIT                                      |
| `define-data-property`                     | 1.1.4        | MIT                                      |
| `define-properties`                        | 1.2.1        | MIT                                      |
| `detect-libc`                              | 2.1.2        | Apache-2.0                               |
| `devtools-protocol`                        | 0.0.1704951  | BSD-3-Clause                             |
| `dijkstrajs`                               | 1.0.3        | MIT                                      |
| `dotenv`                                   | 17.4.2       | BSD-2-Clause                             |
| `drizzle-orm`                              | 0.45.4       | Apache-2.0                               |
| `dunder-proto`                             | 1.0.1        | MIT                                      |
| `duplexer2`                                | 0.1.4        | BSD-3-Clause                             |
| `ecdsa-sig-formatter`                      | 1.0.11       | Apache-2.0                               |
| `emoji-regex`                              | 10.6.0       | MIT                                      |
| `emoji-regex`                              | 10.6.0       | MIT                                      |
| `emoji-regex`                              | 8.0.0        | MIT                                      |
| `emoji-regex`                              | 8.0.0        | MIT                                      |
| `end-of-stream`                            | 1.4.5        | MIT                                      |
| `es-abstract`                              | 1.24.2       | MIT                                      |
| `es-abstract-get`                          | 1.0.0        | MIT                                      |
| `es-define-property`                       | 1.0.1        | MIT                                      |
| `es-errors`                                | 1.3.0        | MIT                                      |
| `es-object-atoms`                          | 1.1.2        | MIT                                      |
| `es-set-tostringtag`                       | 2.1.0        | MIT                                      |
| `es-to-primitive`                          | 1.3.4        | MIT                                      |
| `esbuild`                                  | 0.28.2       | MIT                                      |
| `escalade`                                 | 3.2.0        | MIT                                      |
| `estree-walker`                            | 2.0.2        | MIT                                      |
| `estree-walker`                            | 2.0.2        | MIT                                      |
| `events-universal`                         | 1.0.1        | Apache-2.0                               |
| `exceljs`                                  | 4.4.0        | MIT                                      |
| `fast-csv`                                 | 4.3.6        | MIT                                      |
| `fast-fifo`                                | 1.3.2        | MIT                                      |
| `fast-sha256`                              | 1.3.0        | Unlicense                                |
| `fdir`                                     | 6.5.0        | MIT                                      |
| `fdir`                                     | 6.5.0        | MIT                                      |
| `fdir`                                     | 6.5.0        | MIT                                      |
| `find-up`                                  | 4.1.0        | MIT                                      |
| `for-each`                                 | 0.3.5        | MIT                                      |
| `fs-constants`                             | 1.0.0        | MIT                                      |
| `fs.realpath`                              | 1.0.0        | ISC                                      |
| `fsevents`                                 | 2.3.3        | MIT                                      |
| `fstream`                                  | 1.0.12       | ISC                                      |
| `function-bind`                            | 1.1.2        | MIT                                      |
| `function.prototype.name`                  | 1.2.0        | MIT                                      |
| `functions-have-names`                     | 1.2.3        | MIT                                      |
| `geist`                                    | 1.9.0        | SIL OPEN FONT LICENSE                    |
| `generator-function`                       | 2.0.1        | MIT                                      |
| `get-caller-file`                          | 2.0.5        | ISC                                      |
| `get-east-asian-width`                     | 1.7.0        | MIT                                      |
| `get-intrinsic`                            | 1.3.0        | MIT                                      |
| `get-proto`                                | 1.0.1        | MIT                                      |
| `get-symbol-description`                   | 1.1.0        | MIT                                      |
| `glob`                                     | 13.0.6       | BlueOak-1.0.0                            |
| `glob`                                     | 7.2.3        | ISC                                      |
| `glob`                                     | 7.2.3        | ISC                                      |
| `glob`                                     | 7.2.3        | ISC                                      |
| `globalthis`                               | 1.0.4        | MIT                                      |
| `gopd`                                     | 1.2.0        | MIT                                      |
| `graceful-fs`                              | 4.2.11       | ISC                                      |
| `has-bigints`                              | 1.1.0        | MIT                                      |
| `has-flag`                                 | 4.0.0        | MIT                                      |
| `has-property-descriptors`                 | 1.0.2        | MIT                                      |
| `has-proto`                                | 1.2.0        | MIT                                      |
| `has-symbols`                              | 1.1.0        | MIT                                      |
| `has-tostringtag`                          | 1.0.2        | MIT                                      |
| `hasown`                                   | 2.0.4        | MIT                                      |
| `http_ece`                                 | 1.2.0        | MIT                                      |
| `https-proxy-agent`                        | 7.0.6        | MIT                                      |
| `iceberg-js`                               | 0.8.1        | MIT                                      |
| `ieee754`                                  | 1.2.1        | BSD-3-Clause                             |
| `immediate`                                | 3.0.6        | MIT                                      |
| `inflight`                                 | 1.0.6        | ISC                                      |
| `inherits`                                 | 2.0.4        | ISC                                      |
| `internal-slot`                            | 1.1.0        | MIT                                      |
| `internmap`                                | 2.0.3        | ISC                                      |
| `is-array-buffer`                          | 3.0.5        | MIT                                      |
| `is-async-function`                        | 2.1.1        | MIT                                      |
| `is-bigint`                                | 1.1.0        | MIT                                      |
| `is-boolean-object`                        | 1.2.2        | MIT                                      |
| `is-callable`                              | 1.2.7        | MIT                                      |
| `is-data-view`                             | 1.0.2        | MIT                                      |
| `is-date-object`                           | 1.1.0        | MIT                                      |
| `is-document.all`                          | 1.0.0        | MIT                                      |
| `is-finalizationregistry`                  | 1.1.1        | MIT                                      |
| `is-fullwidth-code-point`                  | 3.0.0        | MIT                                      |
| `is-generator-function`                    | 1.1.2        | MIT                                      |
| `is-map`                                   | 2.0.3        | MIT                                      |
| `is-negative-zero`                         | 2.0.3        | MIT                                      |
| `is-number-object`                         | 1.1.1        | MIT                                      |
| `is-reference`                             | 1.2.1        | MIT                                      |
| `is-regex`                                 | 1.2.1        | MIT                                      |
| `is-set`                                   | 2.0.3        | MIT                                      |
| `is-shared-array-buffer`                   | 1.0.4        | MIT                                      |
| `is-string`                                | 1.1.1        | MIT                                      |
| `is-symbol`                                | 1.1.1        | MIT                                      |
| `is-typed-array`                           | 1.1.15       | MIT                                      |
| `is-weakmap`                               | 2.0.2        | MIT                                      |
| `is-weakref`                               | 1.1.1        | MIT                                      |
| `is-weakset`                               | 2.0.4        | MIT                                      |
| `isarray`                                  | 1.0.0        | MIT                                      |
| `isarray`                                  | 1.0.0        | MIT                                      |
| `isarray`                                  | 1.0.0        | MIT                                      |
| `isarray`                                  | 1.0.0        | MIT                                      |
| `isarray`                                  | 1.0.0        | MIT                                      |
| `isarray`                                  | 2.0.5        | MIT                                      |
| `jose`                                     | 6.2.15       | MIT                                      |
| `json-schema-to-ts`                        | 3.1.1        | MIT                                      |
| `jszip`                                    | 3.10.2       | (MIT OR GPL-3.0-or-later)                |
| `jwa`                                      | 2.0.1        | MIT                                      |
| `jws`                                      | 4.0.1        | MIT                                      |
| `lazystream`                               | 1.0.1        | MIT                                      |
| `lie`                                      | 3.3.0        | MIT                                      |
| `listenercount`                            | 1.0.1        | ISC                                      |
| `locate-path`                              | 5.0.0        | MIT                                      |
| `lodash.camelcase`                         | 4.3.0        | MIT                                      |
| `lodash.defaults`                          | 4.2.0        | MIT                                      |
| `lodash.difference`                        | 4.5.0        | MIT                                      |
| `lodash.escaperegexp`                      | 4.1.2        | MIT                                      |
| `lodash.flatten`                           | 4.4.0        | MIT                                      |
| `lodash.groupby`                           | 4.6.0        | MIT                                      |
| `lodash.isboolean`                         | 3.0.3        | MIT                                      |
| `lodash.isequal`                           | 4.5.0        | MIT                                      |
| `lodash.isfunction`                        | 3.0.9        | MIT                                      |
| `lodash.isnil`                             | 4.0.0        | MIT                                      |
| `lodash.isplainobject`                     | 4.0.6        | MIT                                      |
| `lodash.isundefined`                       | 3.0.1        | MIT                                      |
| `lodash.union`                             | 4.6.0        | MIT                                      |
| `lodash.uniq`                              | 4.5.0        | MIT                                      |
| `long`                                     | 5.3.2        | Apache-2.0                               |
| `lru-cache`                                | 11.5.3       | BlueOak-1.0.0                            |
| `magic-string`                             | 0.30.21      | MIT                                      |
| `math-intrinsics`                          | 1.1.0        | MIT                                      |
| `minimalistic-assert`                      | 1.0.1        | ISC                                      |
| `minimatch`                                | 10.2.6       | BlueOak-1.0.0                            |
| `minimatch`                                | 3.1.5        | ISC                                      |
| `minimatch`                                | 5.1.9        | ISC                                      |
| `minimist`                                 | 1.2.8        | MIT                                      |
| `minipass`                                 | 7.1.3        | BlueOak-1.0.0                            |
| `mitt`                                     | 3.0.1        | MIT                                      |
| `mkdirp`                                   | 0.5.6        | MIT                                      |
| `modern-tar`                               | 0.8.6        | MIT                                      |
| `ms`                                       | 2.1.3        | MIT                                      |
| `nanoid`                                   | 3.3.20       | MIT                                      |
| `next`                                     | 16.4.3       | MIT                                      |
| `normalize-path`                           | 3.0.0        | MIT                                      |
| `object-inspect`                           | 1.13.4       | MIT                                      |
| `object-keys`                              | 1.1.1        | MIT                                      |
| `object.assign`                            | 4.1.7        | MIT                                      |
| `once`                                     | 1.4.0        | ISC                                      |
| `own-keys`                                 | 1.0.2        | MIT                                      |
| `oxc-parser`                               | 0.152.0      | MIT                                      |
| `p-limit`                                  | 2.3.0        | MIT                                      |
| `p-locate`                                 | 4.1.0        | MIT                                      |
| `p-try`                                    | 2.2.0        | MIT                                      |
| `pako`                                     | 1.0.11       | (MIT AND Zlib)                           |
| `papaparse`                                | 5.7.0        | MIT                                      |
| `path-exists`                              | 4.0.0        | MIT                                      |
| `path-is-absolute`                         | 1.0.1        | MIT                                      |
| `path-scurry`                              | 2.0.2        | BlueOak-1.0.0                            |
| `picocolors`                               | 1.1.1        | ISC                                      |
| `picomatch`                                | 4.0.7        | MIT                                      |
| `picomatch`                                | 4.0.7        | MIT                                      |
| `picomatch`                                | 4.0.7        | MIT                                      |
| `picomatch`                                | 4.0.7        | MIT                                      |
| `pngjs`                                    | 5.0.0        | MIT                                      |
| `possible-typed-array-names`               | 1.1.0        | MIT                                      |
| `postal-mime`                              | 2.7.6        | MIT-0                                    |
| `postcss`                                  | 8.5.23       | MIT                                      |
| `postcss`                                  | 8.5.32       | MIT                                      |
| `postgres`                                 | 4.0.0        | Unlicense                                |
| `process-nextick-args`                     | 2.0.1        | MIT                                      |
| `protobufjs`                               | 7.6.6        | BSD-3-Clause                             |
| `pump`                                     | 3.0.4        | MIT                                      |
| `puppeteer-core`                           | 25.16.0      | Apache-2.0                               |
| `qrcode`                                   | 1.5.4        | MIT                                      |
| `react`                                    | 19.3.1       | MIT                                      |
| `react-dom`                                | 19.3.1       | MIT                                      |
| `readable-stream`                          | 2.3.8        | MIT                                      |
| `readable-stream`                          | 2.3.8        | MIT                                      |
| `readable-stream`                          | 2.3.8        | MIT                                      |
| `readable-stream`                          | 2.3.8        | MIT                                      |
| `readable-stream`                          | 2.3.8        | MIT                                      |
| `readable-stream`                          | 3.6.2        | MIT                                      |
| `readdir-glob`                             | 1.1.3        | Apache-2.0                               |
| `reflect.getprototypeof`                   | 1.0.10       | MIT                                      |
| `regexp.prototype.flags`                   | 1.5.4        | MIT                                      |
| `require-directory`                        | 2.1.1        | MIT                                      |
| `require-main-filename`                    | 2.0.0        | ISC                                      |
| `resend`                                   | 6.37.0       | MIT                                      |
| `rimraf`                                   | 2.7.1        | ISC                                      |
| `rollup`                                   | 4.67.4       | MIT                                      |
| `safe-array-concat`                        | 1.1.4        | MIT                                      |
| `safe-buffer`                              | 5.1.2        | MIT                                      |
| `safe-buffer`                              | 5.1.2        | MIT                                      |
| `safe-buffer`                              | 5.1.2        | MIT                                      |
| `safe-buffer`                              | 5.1.2        | MIT                                      |
| `safe-buffer`                              | 5.1.2        | MIT                                      |
| `safe-buffer`                              | 5.2.1        | MIT                                      |
| `safe-push-apply`                          | 1.0.0        | MIT                                      |
| `safe-regex-test`                          | 1.1.0        | MIT                                      |
| `safer-buffer`                             | 2.1.2        | MIT                                      |
| `saxes`                                    | 5.0.1        | ISC                                      |
| `scheduler`                                | 0.28.0       | MIT                                      |
| `semver`                                   | 7.8.5        | ISC                                      |
| `sentry`                                   | 0.45.0       | FSL-1.1-Apache-2.0                       |
| `server-only`                              | 0.0.1        | MIT                                      |
| `set-blocking`                             | 2.0.0        | ISC                                      |
| `set-function-length`                      | 1.2.2        | MIT                                      |
| `set-function-name`                        | 2.0.2        | MIT                                      |
| `set-proto`                                | 1.0.0        | MIT                                      |
| `setimmediate`                             | 1.0.5        | MIT                                      |
| `sharp`                                    | 0.35.5       | Apache-2.0                               |
| `side-channel`                             | 1.1.1        | MIT                                      |
| `side-channel-list`                        | 1.0.1        | MIT                                      |
| `side-channel-map`                         | 1.0.1        | MIT                                      |
| `side-channel-weakmap`                     | 1.0.2        | MIT                                      |
| `source-map-js`                            | 1.2.2        | BSD-3-Clause                             |
| `stacktrace-parser`                        | 0.1.11       | MIT                                      |
| `standardwebhooks`                         | 1.1.1        | MIT                                      |
| `stop-iteration-iterator`                  | 1.1.0        | MIT                                      |
| `streamx`                                  | 2.28.1       | MIT                                      |
| `string_decoder`                           | 1.1.1        | MIT                                      |
| `string_decoder`                           | 1.1.1        | MIT                                      |
| `string_decoder`                           | 1.1.1        | MIT                                      |
| `string_decoder`                           | 1.1.1        | MIT                                      |
| `string_decoder`                           | 1.1.1        | MIT                                      |
| `string_decoder`                           | 1.3.0        | MIT                                      |
| `string-width`                             | 4.2.3        | MIT                                      |
| `string-width`                             | 4.2.3        | MIT                                      |
| `string-width`                             | 7.2.0        | MIT                                      |
| `string-width`                             | 7.2.0        | MIT                                      |
| `string-width`                             | 8.3.0        | MIT                                      |
| `string.prototype.trim`                    | 1.2.11       | MIT                                      |
| `string.prototype.trimend`                 | 1.0.10       | MIT                                      |
| `string.prototype.trimstart`               | 1.0.8        | MIT                                      |
| `strip-ansi`                               | 6.0.1        | MIT                                      |
| `strip-ansi`                               | 6.0.1        | MIT                                      |
| `strip-ansi`                               | 7.2.0        | MIT                                      |
| `styled-jsx`                               | 5.1.6        | MIT                                      |
| `supports-color`                           | 8.1.1        | MIT                                      |
| `tar-fs`                                   | 3.1.3        | MIT                                      |
| `tar-stream`                               | 2.2.0        | MIT                                      |
| `tar-stream`                               | 3.2.2        | MIT                                      |
| `teex`                                     | 1.0.1        | MIT                                      |
| `text-decoder`                             | 1.2.7        | Apache-2.0                               |
| `tinyglobby`                               | 0.2.17       | MIT                                      |
| `tmp`                                      | 0.2.7        | MIT                                      |
| `traverse`                                 | 0.3.10       | MIT                                      |
| `ts-algebra`                               | 2.0.0        | MIT                                      |
| `tslib`                                    | 2.8.1        | 0BSD                                     |
| `tslib`                                    | 2.8.1        | 0BSD                                     |
| `tslib`                                    | 2.8.1        | 0BSD                                     |
| `tslib`                                    | 2.8.1        | 0BSD                                     |
| `tslib`                                    | 2.8.1        | 0BSD                                     |
| `tslib`                                    | 2.9.1        | 0BSD                                     |
| `type-fest`                                | 0.7.1        | (MIT OR CC0-1.0)                         |
| `typed-array-buffer`                       | 1.0.3        | MIT                                      |
| `typed-array-byte-length`                  | 1.0.3        | MIT                                      |
| `typed-array-byte-offset`                  | 1.0.5        | MIT                                      |
| `typed-array-length`                       | 1.0.8        | MIT                                      |
| `typed-query-selector`                     | 2.12.3       | MIT                                      |
| `typedarray.prototype.slice`               | 1.0.6        | MIT                                      |
| `unbox-primitive`                          | 1.1.0        | MIT                                      |
| `undici-types`                             | 8.9.0        | MIT                                      |
| `unzipper`                                 | 0.10.14      | MIT                                      |
| `util-deprecate`                           | 1.0.2        | MIT                                      |
| `uuid`                                     | 8.3.2        | MIT                                      |
| `vite`                                     | 7.3.7        | MIT                                      |
| `web-push`                                 | 3.6.7        | MPL-2.0                                  |
| `web-vitals`                               | 6.2.3        | Apache-2.0                               |
| `webdriver-bidi-protocol`                  | 1.0.1        | Apache-2.0                               |
| `which-boxed-primitive`                    | 1.1.1        | MIT                                      |
| `which-builtin-type`                       | 1.2.1        | MIT                                      |
| `which-collection`                         | 1.0.2        | MIT                                      |
| `which-module`                             | 2.0.1        | ISC                                      |
| `which-typed-array`                        | 1.1.24       | MIT                                      |
| `wrap-ansi`                                | 6.2.0        | MIT                                      |
| `wrap-ansi`                                | 7.0.0        | MIT                                      |
| `wrap-ansi`                                | 9.0.2        | MIT                                      |
| `wrappy`                                   | 1.0.2        | ISC                                      |
| `ws`                                       | 8.22.1       | MIT                                      |
| `xmlchars`                                 | 2.2.0        | MIT                                      |
| `y18n`                                     | 4.0.3        | ISC                                      |
| `y18n`                                     | 5.0.8        | ISC                                      |
| `yargs`                                    | 15.4.1       | MIT                                      |
| `yargs`                                    | 17.7.3       | MIT                                      |
| `yargs`                                    | 18.2.0       | MIT                                      |
| `yargs-parser`                             | 18.1.3       | ISC                                      |
| `yargs-parser`                             | 21.1.1       | ISC                                      |
| `yargs-parser`                             | 22.0.0       | ISC                                      |
| `zip-stream`                               | 4.1.1        | MIT                                      |
| `zod`                                      | 4.6.7        | MIT                                      |
