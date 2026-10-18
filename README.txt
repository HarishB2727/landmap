LAND MAP — how to run it
========================

1. Install Node.js (version 18 or newer) from https://nodejs.org  (one time only)

2. Open Terminal, go into this folder, and start the app:
     cd ~/Downloads/landmap
     node server.js

   You'll see:  Land Map running at http://localhost:3000

3. Open http://localhost:3000 in Chrome.

   Accounts created on first run:
     Admin:     admin / admin123
     Test user: test  / test123
   Change both passwords right away (Admin > Users > Reset password).

   Stop the app with Ctrl+C. Start it again with `node server.js`.
   Everything is kept in the "data" folder (data/db.json and data/uploads).
   Back up that folder; deleting it resets the app.

USING IT ON YOUR PHONE (same Wi-Fi)
  Find your Mac's IP address (System Settings > Wi-Fi > Details, e.g. 192.168.1.20)
  and open http://192.168.1.20:3000 on the phone.
  Note: phones only allow "live location" on https sites, so the blue-dot
  location button works on the phone once the app is online with https (see below).

PUTTING IT ONLINE FOR OTHER PEOPLE
  Upload this folder to any small server or Node host (Render, Railway, a VPS),
  run `node server.js` there, and put it behind https. Set PORT if the host needs it.

ADMIN SCREEN (/admin)
  Listings  - "+ New listing", tap the plot corners, fill details, Save.
              Switch "Published" on to show it to users. Drafts stay hidden.
              Private admin notes are never sent to users.
  Measure   - quick area / distance measuring (not saved)
  Sketch    - freehand planning on the map, saved per person
  Users     - create users, reset passwords, delete users
  Settings  - turn the survey layer and each user tab on/off, app name,
              starting map view, optional Google Maps key

USER SCREEN (/app)
  Listings, Measure, Sketch tabs (whichever the admin switched on).
  Map style button (bottom left of map): Satellite, Google satellite,
  Google map, Street map. The Google ones need the admin's key, and the key's
  Google Cloud project must have billing turned on and "Maps JavaScript API"
  enabled; if not, the menu says what is wrong.
  Layers button (top right of map): survey numbers, side lengths on/off,
  feet/metres.
  Panel button (top right of map): hide or show the side panel.
  While drawing a plot, measuring or editing corners, the top bar and panel
  hide so the map is full screen; they come back when you Finish or Cancel.
