// SPDX-FileCopyrightText: 2026 FrostNova (https://github.com/FrostNovaOrg/world-execute-web)
// SPDX-License-Identifier: AGPL-3.0-or-later
// Derived from world-execute-web `src/player/pace.js` at commit
// 29aefca50e40c14498420e1c6e1f3a1037727e17, used under AGPL-3.0-or-later. See NOTICE.
// Modifications: none — the file is reproduced as published, with this header added.

/** Is a frame due at vsync time `now`? (next: when it is due; refresh: the display's frame interval, ms) */
export const due = (now, next, refresh) => now >= next - refresh / 2;
/** When the frame after one drawn at `now` is due; after a stall the pacing restarts rather than bursting to catch up. */
export const advance = (now, next, frameMs) => (now - next > frameMs ? now : next) + frameMs;
