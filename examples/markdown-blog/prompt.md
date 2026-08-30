# Markdown Blog

A wide fan-out: sample content, post model/frontmatter parsing, and views/routes are independent until they get wired together.

## Prompt

```text
/dag-plan Build a blog app in Ruby on Rails 8 (SQLite3, no gems beyond the Rails defaults plus commonmarker for Markdown).
- Posts live in content/posts/*.md with simple frontmatter (title, date, tags); parse it by hand in app/models/post.rb (no front_matter gem); support reload and expose all_tags
- Routes: / (post list, newest first), /posts/:slug (title, date, tags, and Markdown body rendered with commonmarker), /tags/:tag (posts for that tag, newest first)
- One shared layout (app/views/layouts/application.html.erb) plus a minimal stylesheet at app/assets/stylesheets/application.css
- Tests: Rails minitest in test/ covering frontmatter parsing, date sorting, tag grouping, and each route; `bin/rails test` must pass
- Ship three sample posts in content/posts/ so the app has browsable content
```
