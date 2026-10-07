# quickfinds-status

Checks what a QuickFinds shopper sees, every 10 minutes: search works and has Google results,
Home photos load, the deals feeds are fresh, cash back rates are current, the website loads.
When something breaks it opens an issue titled "QuickFinds alert" (emailed to the owner) and
closes it when everything passes again. `node check.mjs` runs it locally.
