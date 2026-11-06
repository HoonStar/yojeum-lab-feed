# yojeum-lab-feed

Login-free hand-off feed for a publishing agent. Not for search engines (robots.txt disallows all, pages carry noindex).
Posts live under `f/<token>/<date>/<id>/` and are pruned after 3 days. `tools/publish_feed.js` writes a post package into this tree.
