/**
 * Lucide icon markup (https://lucide.dev, v1.49.0), copied so the bundle has no
 * icon dependency: the inner elements of each 24x24 icon (stroke =
 * currentColor, stroke-width / caps / joins set by the wrapping <svg>).
 * Only the icons PainterSketch uses are listed; to add one, copy its inner
 * markup from the Lucide SVG (attribute quotes as ').
 *
 * ISC License
 *
 * Copyright (c) 2026 Lucide Icons and Contributors
 *
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
 * WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
 * MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
 * ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 * WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
 * ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
 * OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 *
 * Of the icons below, check, clipboard, italic, lock, minimize-2, move, plus, trash, type, x are derived from
 * the Feather project:
 *
 * The MIT License (MIT)
 *
 * Copyright (c) 2013-present Cole Bemis
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/** Inner SVG markup per Lucide icon name. */
export const LUCIDE: Readonly<Record<string, string>> = {
  "ban": "<circle cx='12' cy='12' r='10'/><path d='M4.929 4.929 19.07 19.071'/>",
  "bold": "<path d='M6 12h9a4 4 0 0 1 0 8H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h7a4 4 0 0 1 0 8'/>",
  "brush": "<path d='m11 10 3 3'/><path d='M6.5 21A3.5 3.5 0 1 0 3 17.5a2.62 2.62 0 0 1-.708 1.792A1 1 0 0 0 3 21z'/><path d='M9.969 17.031 21.378 5.624a1 1 0 0 0-3.002-3.002L6.967 14.031'/>",
  "brush-cleaning": "<path d='m16 22-1-4'/><path d='M19 14a1 1 0 0 0 1-1v-1a2 2 0 0 0-2-2h-3a1 1 0 0 1-1-1V4a2 2 0 0 0-4 0v5a1 1 0 0 1-1 1H6a2 2 0 0 0-2 2v1a1 1 0 0 0 1 1'/><path d='M19 14H5l-1.973 6.767A1 1 0 0 0 4 22h16a1 1 0 0 0 .973-1.233z'/><path d='m8 22 1-4'/>",
  "check": "<path d='M20 6 9 17l-5-5'/>",
  "circle-dashed": "<path d='M10.1 2.182a10 10 0 0 1 3.8 0'/><path d='M13.9 21.818a10 10 0 0 1-3.8 0'/><path d='M17.609 3.721a10 10 0 0 1 2.69 2.7'/><path d='M2.182 13.9a10 10 0 0 1 0-3.8'/><path d='M20.279 17.609a10 10 0 0 1-2.7 2.69'/><path d='M21.818 10.1a10 10 0 0 1 0 3.8'/><path d='M3.721 6.391a10 10 0 0 1 2.7-2.69'/><path d='M6.391 20.279a10 10 0 0 1-2.69-2.7'/>",
  "circle-dot": "<circle cx='12' cy='12' r='1'/><circle cx='12' cy='12' r='10'/>",
  "clipboard": "<rect width='8' height='4' x='8' y='2' rx='1' ry='1'/><path d='M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2'/>",
  "contrast": "<circle cx='12' cy='12' r='10'/><path d='M12 18a6 6 0 0 0 0-12v12z'/>",
  "copy": "<rect width='14' height='14' x='8' y='8' rx='2' ry='2'/><path d='M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2'/>",
  "copy-plus": "<line x1='15' x2='15' y1='12' y2='18'/><line x1='12' x2='18' y1='15' y2='15'/><rect width='14' height='14' x='8' y='8' rx='2' ry='2'/><path d='M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2'/>",
  "ellipse": "<ellipse cx='12' cy='12' rx='10' ry='6'/>",
  "eraser": "<path d='M21 21H8a2 2 0 0 1-1.42-.587l-3.994-3.999a2 2 0 0 1 0-2.828l10-10a2 2 0 0 1 2.829 0l5.999 6a2 2 0 0 1 0 2.828L12.834 21'/><path d='m5.082 11.09 8.828 8.828'/>",
  "eye": "<path d='M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0'/><circle cx='12' cy='12' r='3'/>",
  "eye-off": "<path d='M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49'/><path d='M14.084 14.158a3 3 0 0 1-4.242-4.242'/><path d='M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143'/><path d='m2 2 20 20'/>",
  "fullscreen": "<path d='M3 7V5a2 2 0 0 1 2-2h2'/><path d='M17 3h2a2 2 0 0 1 2 2v2'/><path d='M21 17v2a2 2 0 0 1-2 2h-2'/><path d='M7 21H5a2 2 0 0 1-2-2v-2'/><rect width='10' height='8' x='7' y='8' rx='1'/>",
  "hand": "<path d='M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2'/><path d='M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2'/><path d='M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8'/><path d='M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15'/>",
  "hand-grab": "<path d='M18 11.5V9a2 2 0 0 0-2-2a2 2 0 0 0-2 2v1.4'/><path d='M14 10V8a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2'/><path d='M10 9.9V9a2 2 0 0 0-2-2a2 2 0 0 0-2 2v5'/><path d='M6 14a2 2 0 0 0-2-2a2 2 0 0 0-2 2'/><path d='M18 11a2 2 0 1 1 4 0v3a8 8 0 0 1-8 8h-4a8 8 0 0 1-8-8 2 2 0 1 1 4 0'/>",
  "hourglass": "<path d='M5 22h14'/><path d='M5 2h14'/><path d='M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22'/><path d='M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2'/>",
  "images": "<path d='m22 11-1.296-1.296a2.4 2.4 0 0 0-3.408 0L11 16'/><path d='M4 8a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2'/><circle cx='13' cy='7' r='1' fill='currentColor'/><rect x='8' y='2' width='14' height='14' rx='2'/>",
  "italic": "<line x1='19' x2='10' y1='4' y2='4'/><line x1='14' x2='5' y1='20' y2='20'/><line x1='15' x2='9' y1='4' y2='20'/>",
  "lasso": "<path d='M3.704 14.467a10 8 0 1 1 3.115 2.375'/><path d='M7 22a5 5 0 0 1-2-3.994'/><circle cx='5' cy='16' r='2'/>",
  "layers-arrow-down": "<path d='M12 7v15'/><path d='M2 12a1 1 0 00.58.91l5.093 2.316'/><path d='M22 12a1 1 0 01-.59.92l-5.077 2.308'/><path d='M8 10.37 2.6 7.91a1 1 0 010-1.831l8.57-3.9a2 2 0 011.66.001l8.59 3.91a1 1 0 010 1.831l-5.392 2.45'/><path d='m9 19 3 3 3-3'/>",
  "lock": "<rect width='18' height='11' x='3' y='11' rx='2' ry='2'/><path d='M7 11V7a5 5 0 0 1 10 0v4'/>",
  "lock-open": "<rect width='18' height='11' x='3' y='11' rx='2' ry='2'/><path d='M7 11V7a5 5 0 0 1 9.9-1'/>",
  "maximize-2": "<path d='M15 3h6v6'/><path d='m21 3-7 7'/><path d='m3 21 7-7'/><path d='M9 21H3v-6'/>",
  "minimize-2": "<path d='m14 10 7-7'/><path d='M20 10h-6V4'/><path d='m3 21 7-7'/><path d='M4 14h6v6'/>",
  "mouse-pointer-2": "<path d='M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z'/>",
  "move": "<path d='M12 2v20'/><path d='m15 19-3 3-3-3'/><path d='m19 9 3 3-3 3'/><path d='M2 12h20'/><path d='m5 9-3 3 3 3'/><path d='m9 5 3-3 3 3'/>",
  "move-diagonal": "<path d='M11 19H5v-6'/><path d='M13 5h6v6'/><path d='M19 5 5 19'/>",
  "move-diagonal-2": "<path d='M19 13v6h-6'/><path d='M5 11V5h6'/><path d='m5 5 14 14'/>",
  "move-horizontal": "<path d='m18 8 4 4-4 4'/><path d='M2 12h20'/><path d='m6 8-4 4 4 4'/>",
  "move-up-right": "<path d='M13 5H19V11'/><path d='M19 5L5 19'/>",
  "move-vertical": "<path d='M12 2v20'/><path d='m8 18 4 4 4-4'/><path d='m8 6 4-4 4 4'/>",
  "paint-bucket": "<path d='M11 7 6 2'/><path d='M18.992 12H2.041'/><path d='M21.145 18.38A3.34 3.34 0 0 1 20 16.5a3.3 3.3 0 0 1-1.145 1.88c-.575.46-.855 1.02-.855 1.595A2 2 0 0 0 20 22a2 2 0 0 0 2-2.025c0-.58-.285-1.13-.855-1.595'/><path d='m8.5 4.5 2.148-2.148a1.205 1.205 0 0 1 1.704 0l7.296 7.296a1.205 1.205 0 0 1 0 1.704l-7.592 7.592a3.615 3.615 0 0 1-5.112 0l-3.888-3.888a3.615 3.615 0 0 1 0-5.112L5.67 7.33'/>",
  "panel-right": "<rect width='18' height='18' x='3' y='3' rx='2'/><path d='M15 3v18'/>",
  "pen": "<path d='M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z'/>",
  "pipette": "<path d='m12 9-8.414 8.414A2 2 0 0 0 3 18.828v1.344a2 2 0 0 1-.586 1.414A2 2 0 0 1 3.828 21h1.344a2 2 0 0 0 1.414-.586L15 12'/><path d='m18 9 .4.4a1 1 0 1 1-3 3l-3.8-3.8a1 1 0 1 1 3-3l.4.4 3.4-3.4a1 1 0 1 1 3 3z'/><path d='m2 22 .414-.414'/>",
  "plus": "<path d='M5 12h14'/><path d='M12 5v14'/>",
  "rectangle-horizontal": "<rect width='20' height='12' x='2' y='6' rx='2'/>",
  "redo-2": "<path d='m15 14 5-5-5-5'/><path d='M20 9H9.5A5.5 5.5 0 0 0 4 14.5A5.5 5.5 0 0 0 9.5 20H13'/>",
  "refresh-cw": "<path d='M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8'/><path d='M21 3v5h-5'/><path d='M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16'/><path d='M8 16H3v5'/>",
  "scaling": "<path d='M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7'/><path d='M14 15H9v-5'/><path d='M16 3h5v5'/><path d='M21 3 9 15'/>",
  "scan-eye": "<path d='M3 7V5a2 2 0 0 1 2-2h2'/><path d='M17 3h2a2 2 0 0 1 2 2v2'/><path d='M21 17v2a2 2 0 0 1-2 2h-2'/><path d='M7 21H5a2 2 0 0 1-2-2v-2'/><circle cx='12' cy='12' r='1'/><path d='M18.944 12.33a1 1 0 0 0 0-.66 7.5 7.5 0 0 0-13.888 0 1 1 0 0 0 0 .66 7.5 7.5 0 0 0 13.888 0'/>",
  "scissors": "<circle cx='6' cy='6' r='3'/><path d='M8.12 8.12 12 12'/><path d='M20 4 8.12 15.88'/><circle cx='6' cy='18' r='3'/><path d='M14.8 14.8 20 20'/>",
  "slash": "<path d='M22 2 2 22'/>",
  "square-dashed": "<path d='M5 3a2 2 0 0 0-2 2'/><path d='M19 3a2 2 0 0 1 2 2'/><path d='M21 19a2 2 0 0 1-2 2'/><path d='M5 21a2 2 0 0 1-2-2'/><path d='M9 3h1'/><path d='M9 21h1'/><path d='M14 3h1'/><path d='M14 21h1'/><path d='M3 9v1'/><path d='M21 9v1'/><path d='M3 14v1'/><path d='M21 14v1'/>",
  "square-dashed-plus": "<path d='M5 3a2 2 0 0 0-2 2'/><path d='M19 3a2 2 0 0 1 2 2'/><path d='M21 19a2 2 0 0 1-2 2'/><path d='M5 21a2 2 0 0 1-2-2'/><path d='M9 3h1'/><path d='M9 21h1'/><path d='M14 3h1'/><path d='M14 21h1'/><path d='M3 9v1'/><path d='M21 9v1'/><path d='M3 14v1'/><path d='M21 14v1'/><path d='M8 12h8'/><path d='M12 8v8'/>",
  "square-dashed-x": "<path d='M14 21h1'/><path d='M14 3h1'/><path d='M19 3a2 2 0 012 2'/><path d='M21 14v1'/><path d='M21 19a2 2 0 01-2 2'/><path d='M21 9v1'/><path d='M3 14v1'/><path d='M3 9v1'/><path d='M5 21a2 2 0 01-2-2'/><path d='M5 3a2 2 0 00-2 2'/><path d='m9 15 6-6'/><path d='M9 21h1'/><path d='M9 3h1'/><path d='m9 9 6 6'/>",
  "text-cursor": "<path d='M17 22h-1a4 4 0 0 1-4-4V6a4 4 0 0 1 4-4h1'/><path d='M7 22h1a4 4 0 0 0 4-4'/><path d='M7 2h1a4 4 0 0 1 4 4'/>",
  "trash": "<path d='M10 11v6'/><path d='M14 11v6'/><path d='M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6'/><path d='M3 6h18'/><path d='M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2'/>",
  "triangles-centerline-dashed-horizontal": "<path d='M10 12H8'/><path d='M16 12h-2'/><path d='M22 12h-2'/><path d='M4 12H2'/><path d='M7.298 20.288A1 1 0 008 22h8a1 1 0 00.703-1.712l-3.991-3.99a1 1 0 00-1.424-.001z'/><path d='M7.298 3.712A1 1 0 018 2h8a1 1 0 01.703 1.712l-3.991 3.99a1 1 0 01-1.424.001z'/>",
  "triangles-centerline-dashed-vertical": "<path d='M12 14v2'/><path d='M12 20v2'/><path d='M12 2v2'/><path d='M12 8v2'/><path d='M20.288 16.703A1 1 0 0022 16V8a1 1 0 00-1.712-.703l-3.99 3.991a1 1 0 00-.001 1.424z'/><path d='M3.712 16.703A1 1 0 012 16V8a1 1 0 011.712-.703l3.99 3.991a1 1 0 01.001 1.424z'/>",
  "type": "<path d='M12 4v16'/><path d='M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2'/><path d='M9 20h6'/>",
  "undo-2": "<path d='M9 14 4 9l5-5'/><path d='M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11'/>",
  "vector-square": "<path d='M17.055 4.533a24 24 0 00-10.11 0'/><path d='M19.467 17.055a24 24 0 000-10.11'/><path d='M4.533 6.945a24 24 0 000 10.11'/><path d='M6.945 19.467a24 24 0 0010.11 0'/><circle cx='19' cy='19' r='2'/><circle cx='19' cy='5' r='2'/><circle cx='5' cy='19' r='2'/><circle cx='5' cy='5' r='2'/>",
  "x": "<path d='M18 6 6 18'/><path d='m6 6 12 12'/>",
};
