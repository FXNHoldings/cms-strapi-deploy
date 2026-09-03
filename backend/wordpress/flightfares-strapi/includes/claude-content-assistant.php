<?php
/**
 * Claude-powered editorial workspace for posts and pages.
 */

if (!defined('ABSPATH')) {
    exit;
}

const FLIGHTFARES_CLAUDE_HISTORY_META = '_flightfares_claude_content_history';

function flightfares_claude_content_actions()
{
    return [
        'research_brief' => 'Content brief',
        'outline' => 'Article outline',
        'article' => 'Long-form draft',
        'write_section' => 'Write a section',
        'rewrite' => 'Rewrite selection',
        'expand' => 'Expand selection',
        'shorten' => 'Shorten selection',
        'clarity' => 'Improve clarity',
        'grammar' => 'Fix grammar',
        'tone' => 'Adjust tone',
        'faq' => 'Generate FAQs',
        'headings' => 'Suggest H2/H3 headings',
        'seo_meta' => 'SEO title, description and keyword',
        'image_alt' => 'Featured-image alt text',
        'internal_links' => 'Internal-link opportunities',
        'external_sources' => 'External-source suggestions',
        'keyword_coverage' => 'Keyword coverage',
        'introduction' => 'Improve introduction',
        'conclusion' => 'Improve conclusion',
        'fact_check' => 'Claims requiring verification',
        'social' => 'Social posts',
        'full_audit' => 'Full content audit',
    ];
}

add_action('rest_api_init', function () {
    register_rest_route('flightfares-strapi/v1', '/claude-content', [
        [
            'methods' => 'GET',
            'callback' => function () {
                return new WP_REST_Response([
                    'history' => get_user_meta(get_current_user_id(), FLIGHTFARES_CLAUDE_HISTORY_META, true) ?: [],
                ], 200);
            },
            'permission_callback' => function () {
                return current_user_can('edit_posts') || current_user_can('edit_pages');
            },
        ],
        [
            'methods' => 'POST',
            'callback' => 'flightfares_claude_content_request',
            'permission_callback' => function (WP_REST_Request $request) {
                $post_id = (int) $request->get_param('postId');
                return $post_id > 0 && current_user_can('edit_post', $post_id);
            },
        ],
    ]);
});

function flightfares_claude_content_request(WP_REST_Request $request)
{
    $post_id = (int) $request->get_param('postId');
    $post = get_post($post_id);
    if (!$post || !in_array($post->post_type, ['post', 'page'], true)) {
        return new WP_Error('invalid_post', 'A valid post or page is required.', ['status' => 400]);
    }

    $actions = flightfares_claude_content_actions();
    $action = sanitize_key($request->get_param('action'));
    if (!isset($actions[$action])) {
        return new WP_Error('invalid_action', 'Choose a valid Claude content action.', ['status' => 400]);
    }

    $apply = sanitize_key($request->get_param('apply'));
    $submitted = $request->get_param('suggestion');
    if ($apply && is_array($submitted)) {
        return flightfares_claude_content_apply($post, $apply, $submitted);
    }

    $secret = (string) get_option(FLIGHTFARES_CLAUDE_SEO_SECRET_OPTION, '');
    if ($secret === '') {
        return new WP_Error('claude_not_configured', 'Claude has not been configured.', ['status' => 503]);
    }

    $content = $request->get_param('content');
    $content = is_string($content) && trim($content) !== '' ? wp_kses_post(wp_unslash($content)) : $post->post_content;
    $title = sanitize_text_field($request->get_param('title') ?: get_the_title($post));
    $selected_text = sanitize_textarea_field($request->get_param('selectedText') ?: '');
    $instruction = sanitize_textarea_field($request->get_param('instruction') ?: '');

    $internal_links = [];
    foreach (get_posts([
        'post_type' => ['post', 'page'],
        'post_status' => 'publish',
        'posts_per_page' => 80,
        'orderby' => 'modified',
        'order' => 'DESC',
    ]) as $linked_post) {
        if ((int) $linked_post->ID !== $post_id) {
            $internal_links[] = [
                'title' => get_the_title($linked_post),
                'url' => get_permalink($linked_post),
            ];
        }
    }

    $response = wp_remote_post('https://cms.fxnstudio.com/api/claude-seo/generate', [
        'timeout' => 180,
        'headers' => [
            'Content-Type' => 'application/json',
            'X-Flightfares-Claude-Secret' => $secret,
        ],
        'body' => wp_json_encode([
            'type' => 'content',
            'action' => $action,
            'title' => $title,
            'content' => $content,
            'selectedText' => $selected_text,
            'instruction' => $instruction,
            'excerpt' => wp_strip_all_tags($post->post_excerpt),
            'currentSeoTitle' => get_post_meta($post_id, 'rank_math_title', true),
            'currentSeoDescription' => get_post_meta($post_id, 'rank_math_description', true),
            'currentFocusKeyword' => get_post_meta($post_id, 'rank_math_focus_keyword', true),
            'internalLinks' => $internal_links,
        ]),
    ]);
    if (is_wp_error($response)) {
        return new WP_Error('claude_request_failed', $response->get_error_message(), ['status' => 502]);
    }

    $status = wp_remote_retrieve_response_code($response);
    $body = json_decode(wp_remote_retrieve_body($response), true);
    if ($status < 200 || $status >= 300 || !is_array($body)) {
        $message = is_array($body) && is_string($body['error'] ?? null) ? $body['error'] : 'Claude content request failed.';
        return new WP_Error('claude_request_failed', sanitize_text_field($message), ['status' => 502]);
    }

    $result = [
        'action' => $action,
        'actionLabel' => $actions[$action],
        'format' => in_array($body['format'] ?? '', ['html', 'text', 'json'], true) ? $body['format'] : 'html',
        'output' => wp_kses_post((string) ($body['output'] ?? '')),
        'seoTitle' => sanitize_text_field($body['seoTitle'] ?? ''),
        'seoDescription' => sanitize_text_field($body['seoDescription'] ?? ''),
        'focusKeyword' => sanitize_text_field($body['focusKeyword'] ?? ''),
        'imageAlt' => sanitize_text_field($body['imageAlt'] ?? ''),
        'suggestions' => array_map('sanitize_text_field', is_array($body['suggestions'] ?? null) ? array_slice($body['suggestions'], 0, 20) : []),
        'selectedText' => $selected_text,
    ];

    $history = get_user_meta(get_current_user_id(), FLIGHTFARES_CLAUDE_HISTORY_META, true);
    $history = is_array($history) ? $history : [];
    array_unshift($history, [
        'time' => current_time('mysql'),
        'postId' => $post_id,
        'postTitle' => get_the_title($post_id),
        'action' => $actions[$action],
        'output' => wp_trim_words(wp_strip_all_tags($result['output']), 45),
    ]);
    update_user_meta(get_current_user_id(), FLIGHTFARES_CLAUDE_HISTORY_META, array_slice($history, 0, 30));

    return new WP_REST_Response($result, 200);
}

function flightfares_claude_content_apply($post, $apply, array $suggestion)
{
    $post_id = (int) $post->ID;
    $output = wp_kses_post((string) ($suggestion['output'] ?? ''));
    if ($apply === 'replace_content' || $apply === 'append_content') {
        if ($output === '') {
            return new WP_Error('empty_output', 'Claude did not return content to apply.', ['status' => 400]);
        }
        $content = $apply === 'append_content' ? $post->post_content . "\n\n" . $output : $output;
        $updated = wp_update_post(['ID' => $post_id, 'post_content' => wp_slash($content)], true);
        if (is_wp_error($updated)) return $updated;
    } elseif ($apply === 'seo_meta') {
        update_post_meta($post_id, 'rank_math_title', sanitize_text_field($suggestion['seoTitle'] ?? ''));
        update_post_meta($post_id, 'rank_math_description', sanitize_text_field($suggestion['seoDescription'] ?? ''));
        update_post_meta($post_id, 'rank_math_focus_keyword', sanitize_text_field($suggestion['focusKeyword'] ?? ''));
    } elseif ($apply === 'image_alt') {
        $thumbnail_id = get_post_thumbnail_id($post_id);
        if (!$thumbnail_id) return new WP_Error('no_featured_image', 'This post has no featured image.', ['status' => 400]);
        update_post_meta($thumbnail_id, '_wp_attachment_image_alt', sanitize_text_field($suggestion['imageAlt'] ?? ''));
    } else {
        return new WP_Error('invalid_apply_action', 'Choose a valid apply action.', ['status' => 400]);
    }

    clean_post_cache($post_id);
    return new WP_REST_Response(['applied' => true, 'apply' => $apply], 200);
}

add_action('add_meta_boxes', function () {
    foreach (['post', 'page'] as $post_type) {
        add_meta_box(
            'flightfares-claude-content',
            'Claude Content Assistant',
            'flightfares_render_claude_content_box',
            $post_type,
            'normal',
            'high'
        );
    }
});

function flightfares_claude_action_options()
{
    $groups = [
        'Plan & write' => ['research_brief', 'outline', 'article', 'write_section', 'faq', 'headings', 'introduction', 'conclusion'],
        'Improve text' => ['rewrite', 'expand', 'shorten', 'clarity', 'grammar', 'tone'],
        'SEO & discovery' => ['seo_meta', 'internal_links', 'external_sources', 'keyword_coverage', 'image_alt', 'fact_check', 'full_audit'],
        'Promotion' => ['social'],
    ];
    $actions = flightfares_claude_content_actions();
    foreach ($groups as $label => $keys) {
        echo '<optgroup label="' . esc_attr($label) . '">';
        foreach ($keys as $key) {
            echo '<option value="' . esc_attr($key) . '">' . esc_html($actions[$key]) . '</option>';
        }
        echo '</optgroup>';
    }
}

function flightfares_render_claude_content_box($post)
{
    echo '<div class="ff-content-assistant" data-post-id="' . (int) $post->ID . '">';
    echo '<div class="ff-ca-controls"><select class="ff-ca-action">';
    flightfares_claude_action_options();
    echo '</select><input class="ff-ca-instruction" type="text" placeholder="Optional instructions, audience or tone">';
    echo '<button type="button" class="button button-primary ff-ca-generate">Generate preview</button></div>';
    echo '<p class="description">Select text in the editor before using a selection action. Claude never changes the post until you apply an output.</p>';
    echo '<div class="ff-ca-status" aria-live="polite"></div><div class="ff-ca-result" hidden>';
    echo '<div class="ff-ca-preview"></div><textarea class="widefat ff-ca-output" rows="10"></textarea>';
    echo '<div class="ff-ca-meta"></div><p class="ff-ca-buttons">';
    echo '<button type="button" class="button ff-ca-replace-selection">Replace selection</button> ';
    echo '<button type="button" class="button ff-ca-append">Append to article</button> ';
    echo '<button type="button" class="button ff-ca-replace">Replace article</button> ';
    echo '<button type="button" class="button ff-ca-apply-meta">Apply SEO meta</button> ';
    echo '<button type="button" class="button ff-ca-apply-alt">Apply image alt</button> ';
    echo '<button type="button" class="button ff-ca-copy">Copy</button></p></div></div>';
}

add_action('admin_menu', function () {
    add_menu_page('Claude SEO', 'Claude SEO', 'edit_posts', 'flightfares-claude-seo', 'flightfares_render_claude_content_page', 'dashicons-superhero-alt', 58);
    add_submenu_page('flightfares-claude-seo', 'Content Assistant', 'Content Assistant', 'edit_posts', 'flightfares-claude-seo', 'flightfares_render_claude_content_page');
});

function flightfares_render_claude_content_page()
{
    $posts = get_posts(['post_type' => ['post', 'page'], 'post_status' => ['publish', 'draft', 'pending', 'future'], 'posts_per_page' => 200, 'orderby' => 'modified', 'order' => 'DESC']);
    echo '<div class="wrap"><h1>Claude Content Assistant</h1><p>Plan, draft and optimize FlightFares content with Claude. Outputs are previews until you explicitly apply them.</p>';
    echo '<div class="ff-ca-workspace"><section class="ff-ca-card"><h2>Content workspace</h2><label>Post or page</label><select id="ff-ca-page-post"><option value="">Choose content…</option>';
    foreach ($posts as $post) echo '<option value="' . (int) $post->ID . '">' . esc_html(get_the_title($post) . ' — ' . ucfirst($post->post_type)) . '</option>';
    echo '</select><label>Action</label><select class="ff-ca-action">'; flightfares_claude_action_options(); echo '</select>';
    echo '<label>Instructions</label><textarea class="ff-ca-instruction" rows="4" placeholder="Audience, tone, section topic, constraints or objective"></textarea>';
    echo '<p><button class="button button-primary ff-ca-generate">Generate preview</button></p><div class="ff-ca-status" aria-live="polite"></div><div class="ff-ca-result" hidden><div class="ff-ca-preview"></div><textarea class="widefat ff-ca-output" rows="14"></textarea><div class="ff-ca-meta"></div><p><button class="button ff-ca-append">Append to article</button> <button class="button ff-ca-replace">Replace article</button> <button class="button ff-ca-apply-meta">Apply SEO meta</button> <button class="button ff-ca-apply-alt">Apply image alt</button> <button class="button ff-ca-copy">Copy</button></p></div></section>';
    echo '<aside class="ff-ca-card"><h2>Recent history</h2><div id="ff-ca-history">Loading…</div></aside></div></div>';
}

add_action('admin_footer-post.php', 'flightfares_claude_content_assets');
add_action('admin_footer-post-new.php', 'flightfares_claude_content_assets');
add_action('admin_footer-toplevel_page_flightfares-claude-seo', 'flightfares_claude_content_assets');

function flightfares_claude_content_assets()
{
    $endpoint = rest_url('flightfares-strapi/v1/claude-content');
    $nonce = wp_create_nonce('wp_rest');
    ?>
    <style>
    .ff-ca-controls{display:grid;grid-template-columns:minmax(180px,240px) 1fr auto;gap:10px}.ff-ca-status{margin:12px 0;font-weight:600}.ff-ca-preview{background:#fff;border:1px solid #dcdcde;padding:16px;max-height:420px;overflow:auto;margin-bottom:10px}.ff-ca-output{font-family:ui-monospace,monospace}.ff-ca-meta{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:10px}.ff-ca-meta>div{padding:10px;background:#f6f7f7;border:1px solid #dcdcde}.ff-ca-workspace{display:grid;grid-template-columns:minmax(0,2fr) minmax(280px,1fr);gap:20px;max-width:1370px}.ff-ca-card{background:#fff;border:1px solid #dcdcde;padding:20px}.ff-ca-card>label{display:block;font-weight:600;margin:14px 0 5px}.ff-ca-card select,.ff-ca-card textarea{width:100%;max-width:none}.ff-ca-history-item{border-bottom:1px solid #ddd;padding:10px 0}.ff-ca-buttons{margin-bottom:0}@media(max-width:900px){.ff-ca-controls,.ff-ca-workspace,.ff-ca-meta{grid-template-columns:1fr}}
    </style>
    <script>
    (() => {
      const endpoint=<?php echo wp_json_encode($endpoint); ?>, nonce=<?php echo wp_json_encode($nonce); ?>;
      const esc=v=>String(v||'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#039;','"':'&quot;'}[c]));
      let lastSelection='';document.addEventListener('selectionchange',()=>{const value=String(window.getSelection?.()?.toString()||'').trim();if(value)lastSelection=value});
      const editedContent=()=>window.wp?.data?.select('core/editor')?.getEditedPostContent?.()||document.querySelector('#content')?.value||'';
      const editedTitle=()=>window.wp?.data?.select('core/editor')?.getEditedPostAttribute?.('title')||document.querySelector('#title')?.value||'';
      const selected=()=>String(window.getSelection?.()?.toString()||'').trim()||lastSelection;
      const postId=root=>Number(root.dataset.postId||document.querySelector('#ff-ca-page-post')?.value||window.wp?.data?.select('core/editor')?.getCurrentPostId?.()||0);
      const setEditorContent=value=>{if(window.wp?.data?.dispatch('core/editor')?.editPost)window.wp.data.dispatch('core/editor').editPost({content:value});else{const area=document.querySelector('#content');if(area){area.value=value;window.tinymce?.get('content')?.setContent(value)}}};
      async function api(body){const r=await fetch(endpoint,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-WP-Nonce':nonce},body:JSON.stringify(body)});const d=await r.json();if(!r.ok)throw new Error(d.message||'Claude request failed.');return d}
      function render(root,data){root._suggestion=data;root.querySelector('.ff-ca-result').hidden=false;root.querySelector('.ff-ca-output').value=data.output||'';root.querySelector('.ff-ca-preview').innerHTML=data.output||'<em>No content output for this action.</em>';root.querySelector('.ff-ca-meta').innerHTML=[['SEO title',data.seoTitle],['Description',data.seoDescription],['Focus keyword',data.focusKeyword],['Image alt',data.imageAlt]].filter(x=>x[1]).map(x=>'<div><strong>'+esc(x[0])+'</strong><br>'+esc(x[1])+'</div>').join('')+((data.suggestions||[]).length?'<div><strong>Suggestions</strong><ul><li>'+data.suggestions.map(esc).join('</li><li>')+'</li></ul></div>':'');root.querySelector('.ff-ca-status').textContent='Preview ready. Review it before applying.'}
      document.querySelectorAll('.ff-content-assistant,.ff-ca-workspace').forEach(root=>{
        const generate=root.querySelector('.ff-ca-generate');if(!generate)return;
        generate.addEventListener('click',async e=>{e.preventDefault();const id=postId(root);if(!id){root.querySelector('.ff-ca-status').textContent='Choose a post or page first.';return}root.querySelector('.ff-ca-status').textContent='Claude is working…';generate.disabled=true;try{render(root,await api({postId:id,action:root.querySelector('.ff-ca-action').value,instruction:root.querySelector('.ff-ca-instruction').value,selectedText:selected(),content:editedContent(),title:editedTitle()}));loadHistory()}catch(err){root.querySelector('.ff-ca-status').textContent=err.message}finally{generate.disabled=false}});
        root.querySelector('.ff-ca-output')?.addEventListener('input',e=>{if(root._suggestion)root._suggestion.output=e.target.value});
        root.querySelector('.ff-ca-copy')?.addEventListener('click',e=>{e.preventDefault();navigator.clipboard.writeText(root.querySelector('.ff-ca-output').value);root.querySelector('.ff-ca-status').textContent='Copied.'});
        root.querySelector('.ff-ca-replace-selection')?.addEventListener('click',e=>{e.preventDefault();const old=root._suggestion?.selectedText||selected(),replacement=root.querySelector('.ff-ca-output').value,current=editedContent();if(!old||!current.includes(old)){root.querySelector('.ff-ca-status').textContent='The selected text could not be matched. Copy the output or select plain text and regenerate.';return}setEditorContent(current.replace(old,replacement));root.querySelector('.ff-ca-status').textContent='Selection replaced in the editor. Save or update the post to keep it.'});
        [['.ff-ca-append','append_content'],['.ff-ca-replace','replace_content'],['.ff-ca-apply-meta','seo_meta'],['.ff-ca-apply-alt','image_alt']].forEach(([selector,apply])=>root.querySelector(selector)?.addEventListener('click',async e=>{e.preventDefault();if(!root._suggestion)return;const destructive=apply==='replace_content';if(destructive&&!confirm('Replace the complete article with this preview? WordPress revisions can restore the previous version.'))return;if(root.classList.contains('ff-content-assistant')&&(apply==='append_content'||apply==='replace_content')){const output=root.querySelector('.ff-ca-output').value;setEditorContent(apply==='append_content'?editedContent()+'\n\n'+output:output);root.querySelector('.ff-ca-status').textContent='Applied in the editor. Save or update the post to keep it.';return}root.querySelector('.ff-ca-status').textContent='Applying…';try{await api({postId:postId(root),action:root._suggestion.action,apply,suggestion:root._suggestion});root.querySelector('.ff-ca-status').textContent='Applied successfully. Reload the editor to see server-side changes.'}catch(err){root.querySelector('.ff-ca-status').textContent=err.message}}));
      });
      async function loadHistory(){const box=document.querySelector('#ff-ca-history');if(!box)return;try{const r=await fetch(endpoint,{credentials:'same-origin',headers:{'X-WP-Nonce':nonce}}),d=await r.json();box.innerHTML=(d.history||[]).map(h=>'<div class="ff-ca-history-item"><strong>'+esc(h.action)+'</strong><br>'+esc(h.postTitle)+'<br><small>'+esc(h.time)+'</small><p>'+esc(h.output)+'</p></div>').join('')||'<p>No Claude history yet.</p>'}catch(e){box.textContent='History could not be loaded.'}}
      loadHistory();
    })();
    </script>
    <?php
}
