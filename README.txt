SPHERICAL BATTLEFIELD — MULTIPLAYER

Run locally:
  node server.js
Then open http://localhost:8080

Controls:
  WASD       move
  Mouse      look (pointer lock)
  Left click attack / shoot
  Right click aim
  E          weapon wheel
  F          first/third person
  G          emote wheel
  Space      jump
  Q          crouch
  Shift      sprint
  Esc        release pointer lock

Multiplayer additions:
- Health, names and kill-streak leaderboard sync through the server.
- Rifle, minigun, sniper, knife, bat and lightsaber damage other players.
- Grenade and air strike splash damage can also hurt the caller.
- Emotes sync so other players can see them.

Performance changes:
- High-performance WebGL preference.
- Render pixel ratio capped at 1.35.
- Shadows disabled and expensive world geometry/lights reduced.

Render hosting:
Keep server.js and game.html in the same repository. Render start command: node server.js

MOVEMENT CATEGORY
-----------------
Open the weapon wheel with E and choose Movement. Movement equipment is secondary and does not replace your normal weapon.
- Grapple Hook: press R to attach/release. It can latch onto the spherical ground, tree trunks, fence posts and torches.
- Dash: press R for a fast burst; the equipped item is a glowing green baton.
- Jump Boots: Space becomes a super jump; a glowing upward-arrow device is visible in first person.
- Teleport Beacon: press R to throw the white beacon. After it lands, your next left-click attack teleports you to it instead of attacking.


ACCOUNT SAVING
--------------
Accounts are stored in accounts.json by default. Passwords are not stored directly:
the server stores a PBKDF2 password hash and random salt.

For durable accounts on Render, attach a Persistent Disk and set:
ACCOUNT_FILE=/var/data/accounts.json
(or point ACCOUNT_FILE at the path of your mounted Render disk).
Without persistent storage, Render may reset local account data after a redeploy/restart.

BATTLE ROYALE
-------------
Battle Royale is a separate 12-player queue from Quick Play. The queue starts when
12 players arrive, or after a short countdown once at least 2 players are waiting.


LATEST FIXES
------------
- Spawn protection is authoritative on the server and bullets visibly collide with the forcefield.
- The global leaderboard ranks ALL-TIME TROPHIES WON, not the current spendable balance.
- Battle Royale now has one large central planet plus 12 physically separate starting planets.
  Each of the 12 players starts on a different small planet.
- Battle Royale movement uses the nearest planet as its gravity body, so players can stand/run
  around the small planets and grapple across space toward other planets/the central planet.
- Equipped tops, hair and trousers are applied after team colouring and use independent materials
  per network player. Equipped top colour is also used on the first-person sleeve.


ACCOUNT LOGIN REBUILD
---------------------
The account handshake is now separate from lobby/game requests.
Creating an account:
1. Waits for the WebSocket server acknowledgement.
2. Sends one dedicated auth request.
3. Clears the auth retry as soon as authOk/authError is received.
4. Shows a visible error instead of silently hanging.
5. Verifies the account database is writable before confirming a new account.
6. If a configured ACCOUNT_FILE path is unavailable, the server falls back to ./accounts.json.

For permanent Render storage, a Persistent Disk is still recommended. Set ACCOUNT_FILE
to the mounted disk path (for example /var/data/accounts.json). Without a persistent
disk, accounts created in fallback/local storage can disappear on a Render redeploy.


ACCOUNT SYSTEM REBUILT + VERIFIED
---------------------------------
The login/create-account flow no longer shares the lobby retry queue.
It has its own request, timeout, retry, success and error handling.

Verified:
- fresh account creation
- database write to disk
- login after restarting the Node server
- incorrect-password rejection
- password is stored only as a PBKDF2 hash + salt
- invalid/unavailable ACCOUNT_FILE falls back to local accounts.json
- successful auth clears all auth retry timers

For permanent Render accounts, mount a Persistent Disk and point ACCOUNT_FILE
to that mounted path. If it is configured incorrectly, the server will now
fall back locally rather than leaving the login screen hanging.


ACCOUNT BUTTON V4
-----------------
The login/create button now has an independent bootstrap click handler which runs
before the 3D module. A click must immediately show CLICK RECEIVED and then a
specific status/error. It can no longer silently do nothing.

The client also requires server protocol account-v4. If an older server.js is
still deployed, the login screen explicitly says OLD SERVER DETECTED.

Diagnostic endpoint:
  /health
returns JSON including build=account-v4 and the account database filename.
