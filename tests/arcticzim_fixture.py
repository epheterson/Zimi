"""Pages the shape ArcticZim writes (read off a real r/Kiwix build,
2026-09-19): minified, lowercase tags, attribute values without quotes,
paragraphs left open, listing pages ending in a slash."""

LISTING = (
    '<!doctype html><meta content="text/html;charset=UTF-8" http-equiv=Content-Type><title>r/kiwix - top posts</title><body>'
    "<div class=nav><a href=../../..>ArcticZim</a> - <a href=../../../subreddits/>Subreddits</a></div>"
    "<div class=banner><a href=../../../r/kiwix/><h1 class=bannertext>r/kiwix</h1></a></div><div class=content-cntr>"
    "<div class=subredditnav><a href=../../../r/kiwix/top_page_1/>Top</a><a href=../../../r/kiwix/new_page_1/>New</a></div>"
    "<div class=subredditposts><div class=postlist>"
    "<div class=postsummary data-post=abc12 data-subreddit=kiwix><div class=posttitle-container><h1 class=postscore>42</h1>"
    "<img class=posticon src=../../../icons/icon_text.png><h1 class=posttitle><a href=../../../r/kiwix/abc12/>Zimi 1.9 is out &amp; it is good</a></h1>"
    '<p style="color: light" class=postflair>Release</div><p class=postmeta>Posted 2026-09-01T12:00:00 by <a class=authorlink href=../../../u/eric/>eric</a>'
    "<p class=postmeta2><a href=../../../r/kiwix/abc12/>3 comments</a> <a href=../../../abc12>permalink</a> <a href=https://redd.it/abc12/>original</a></div>"
    "<div class=postsummary data-post=def34 data-subreddit=kiwix><div class=posttitle-container><h1 class=postscore>7</h1>"
    "<img class=posticon src=../../../icons/icon_link.png><h1 class=posttitle><a href=https://example.org/article>A link post</a></h1></div>"
    "<p class=postmeta>Posted 2026-08-30T09:00:00 by <a class=authorlink href=../../../u/someone/>someone</a>"
    "<p class=postmeta2><a href=../../../r/kiwix/def34/>0 comments</a></div>"
    '</div></div><div class=page_buttons id=page_buttons><div class="page_button cur_page_button"><a class="page_button_link cur_page_button_link" href=../top_page_1/>1</a></div>'
    "<div class=page_button><a class=page_button_link href=../top_page_2/>2</a></div><div class=page_button>...</div>"
    "<div class=page_button><a class=page_button_link href=../top_page_7/>7</a></div></div></div>"
)

POST = (
    '<!doctype html><meta content=eric name=author><meta content="Score: 42, Comments: 3, Type: Post" name=keywords><title>Zimi 1.9 is out &amp; it is good</title>'
    "<script src=../../../scripts/collapser.js></script><body>"
    "<div class=nav><a href=../../..>ArcticZim</a> - <a href=../../../subreddits/>Subreddits</a></div>"
    "<div class=banner><a href=../../../r/kiwix/><h1 class=bannertext>r/kiwix</h1></a></div><div class=content-cntr><div class=post>"
    "<div class=postsummary data-post=abc12 data-subreddit=kiwix><div class=posttitle-container><h1 class=postscore>42</h1>"
    "<img class=posticon src=../../../icons/icon_text.png><h1 class=posttitle><a href=../../../r/kiwix/abc12/>Zimi 1.9 is out &amp; it is good</a></h1>"
    '<p style="color: light" class=postflair>Release</div><p class=postmeta>Posted 2026-09-01T12:00:00 by <a class=authorlink href=../../../u/eric/>eric</a></div>'
    '<div class=postbody data-nsfw=0 data-spoiler=0 id=postbody><div class="postbodytext mdbody"><p>Maps, ZimiTube and more. <a href=../../r/kiwix/def34/>see also</a> <img src=../../images/x.png></div></div>'
    "<p class=postmeta2><a href=../../../r/kiwix/abc12/>3 comments</a> <a href=../../../abc12>permalink</a></div>"
    "<div class=comments><div class=commentlist>"
    '<div class="comment comment-layer-1" id=comment-c1><p class=commenttitle><a class=collapser>[-]</a> <a class=authorlink href=../../../u/alice/>alice</a> <b>10 points</b> on 2026-09-01T13:00:00'
    '<div class=commentcontent><div class="commentbody mdbody"><p>Nice.</div>'
    '<div class=commentlist><div class="comment comment-layer-2" id=comment-c2><p class="commenttitle distinguished-submmitter"><a class=collapser>[-]</a> <a class=authorlink href=../../../u/bob/>bob</a> <b>3 points</b> on 2026-09-01T14:00:00'
    '<div class=commentcontent><div class="commentbody mdbody"><p>Agreed <script>x()</script></div></div><p class=commentmeta2><a href=../../../r/kiwix/abc12/#comment-c2>Permalink</a></div></div>'
    "</div><p class=commentmeta2><a href=../../../r/kiwix/abc12/#comment-c1>Permalink</a></div>"
    '<div class="comment comment-layer-1" id=comment-c3><p class=commenttitle><a class=collapser>[-]</a> <a class=authorlink href=../../../u/carol/>carol</a> <b>1 points</b> on 2026-09-02T08:00:00'
    '<div class=commentcontent><div class="commentbody mdbody"><p>Top level too.</div></div><p class=commentmeta2><a href=../../../r/kiwix/abc12/#comment-c3>Permalink</a></div>'
    "</div></div></div></div>"
)

SUBS = (
    "<!doctype html><title>Subreddits</title><body><div class=nav><a href=..>ArcticZim</a> - <a href=../subreddits/>Subreddits</a></div>"
    "<div class=content-cntr><div class=subredditlist><ul>"
    "<li><a class=subredditinfo-link href=../../r/kiwix/> <div class=subredditinfo><h1>r/kiwix</h1><p>2 posts</div> </a>"
    "<li><a class=subredditinfo-link href=../../r/selfhosted/> <div class=subredditinfo><h1>r/selfhosted</h1><p>0 posts</div> </a>"
    '</ul></div><div class=page_buttons id=page_buttons><div class="page_button cur_page_button"><a class="page_button_link cur_page_button_link" href=../subreddits_page_1/>1</a></div></div></div>'
)
