/* Client script for /m-export transcript pages. Labels arrive through window.MPEP. */
(function () {
	'use strict';

	var L = window.MPEP || {};
	var transcript = document.getElementById('transcript');
	var searchInput = document.getElementById('q');
	var matchesLabel = document.getElementById('matches');
	var autoOpened = [];

	function text(key, fallback) {
		return L[key] || fallback;
	}

	function escapeHtml(value) {
		return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	}

	// ── markdown ─────────────────────────────────────────────────────────────
	function safeUrl(href, allowDataImage) {
		var value = String(href || '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
		if (value === '') return null;
		var lower = value.toLowerCase();
		if (lower.indexOf('javascript:') === 0 || lower.indexOf('vbscript:') === 0) return null;
		if (lower.indexOf('data:') === 0 && !(allowDataImage && lower.indexOf('data:image/') === 0)) return null;
		return value;
	}

	function setupMarkdown() {
		if (!window.marked) return;
		marked.use({
			breaks: true,
			gfm: true,
			tokenizer: {
				// Tool output and transcripts are data, not markup: show raw HTML verbatim.
				html: function () { return undefined; },
				tag: function () { return undefined; }
			},
			renderer: {
				link: function (token) {
					var href = safeUrl(token.href, false);
					if (href === null) return this.parser.parseInline(token.tokens);
					var out = '<a href="' + escapeHtml(href) + '" target="_blank" rel="noreferrer"';
					if (token.title) out += ' title="' + escapeHtml(token.title) + '"';
					return out + '>' + this.parser.parseInline(token.tokens) + '</a>';
				},
				image: function (token) {
					var href = safeUrl(token.href, true);
					if (href === null) return escapeHtml(token.text || '');
					return '<img src="' + escapeHtml(href) + '" alt="' + escapeHtml(token.text || '') + '" loading="lazy">';
				},
				code: function (token) {
					var code = token.text || '';
					var lang = token.lang || '';
					var body = escapeHtml(code);
					if (window.hljs) {
						try {
							body = lang && hljs.getLanguage(lang)
								? hljs.highlight(code, { language: lang }).value
								: hljs.highlightAuto(code).value;
						} catch (error) {
							body = escapeHtml(code);
						}
					}
					return '<pre><code class="hljs">' + body + '</code></pre>';
				}
			}
		});
	}

	function renderMarkdown() {
		transcript.querySelectorAll('[data-md]').forEach(function (node) {
			if (node.dataset.rendered === '1') return;
			var source = node.textContent || '';
			try {
				node.innerHTML = window.marked ? marked.parse(source) : escapeHtml(source).replace(/\n/g, '<br>');
			} catch (error) {
				node.textContent = source;
			}
			node.dataset.rendered = '1';
		});
	}

	function addCopyButtons() {
		transcript.querySelectorAll('pre').forEach(function (pre) {
			if (pre.querySelector('.copy')) return;
			var button = document.createElement('button');
			button.type = 'button';
			button.className = 'copy';
			button.textContent = text('copy', 'copy');
			button.addEventListener('click', function (event) {
				event.stopPropagation();
				var done = function () {
					button.textContent = text('copied', 'copied');
					setTimeout(function () { button.textContent = text('copy', 'copy'); }, 1200);
				};
				var value = pre.innerText || pre.textContent || '';
				if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(value).then(done, done);
				else done();
			});
			pre.appendChild(button);
		});
	}

	function paint() {
		renderMarkdown();
		addCopyButtons();
	}

	// ── disclosures ──────────────────────────────────────────────────────────
	function setAll(open) {
		transcript.querySelectorAll('[data-fold]').forEach(function (fold) {
			fold.setAttribute('data-open', open ? '1' : '0');
		});
	}

	document.addEventListener('click', function (event) {
		var head = event.target && event.target.closest ? event.target.closest('.head') : null;
		if (!head) return;
		var fold = head.parentElement;
		if (!fold || !fold.hasAttribute('data-fold')) return;
		fold.setAttribute('data-open', fold.getAttribute('data-open') === '1' ? '0' : '1');
	});

	document.querySelectorAll('.bar button[data-act]').forEach(function (button) {
		button.addEventListener('click', function () {
			setAll(button.getAttribute('data-act') === 'expand');
		});
	});

	// ── search ───────────────────────────────────────────────────────────────
	function clearMarks() {
		transcript.querySelectorAll('mark').forEach(function (mark) {
			var parent = mark.parentNode;
			if (!parent) return;
			parent.replaceChild(document.createTextNode(mark.textContent || ''), mark);
			parent.normalize();
		});
	}

	function highlight(root, query) {
		var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
			acceptNode: function (node) {
				var parent = node.parentNode;
				if (!parent || !node.nodeValue) return NodeFilter.FILTER_REJECT;
				var name = parent.nodeName;
				if (name === 'BUTTON' || name === 'MARK' || name === 'SCRIPT' || name === 'STYLE') return NodeFilter.FILTER_REJECT;
				return node.nodeValue.toLowerCase().indexOf(query) === -1 ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
			}
		});
		var targets = [];
		while (walker.nextNode()) targets.push(walker.currentNode);
		targets.forEach(function (node) {
			var value = node.nodeValue || '';
			var lower = value.toLowerCase();
			var fragment = document.createDocumentFragment();
			var index = 0;
			var at = lower.indexOf(query, index);
			while (at !== -1) {
				if (at > index) fragment.appendChild(document.createTextNode(value.slice(index, at)));
				var mark = document.createElement('mark');
				mark.textContent = value.slice(at, at + query.length);
				fragment.appendChild(mark);
				index = at + query.length;
				at = lower.indexOf(query, index);
			}
			if (index < value.length) fragment.appendChild(document.createTextNode(value.slice(index)));
			node.parentNode.replaceChild(fragment, node);
		});
	}

	function applySearch() {
		var query = (searchInput.value || '').trim().toLowerCase();
		clearMarks();
		autoOpened.forEach(function (fold) { fold.setAttribute('data-open', '0'); });
		autoOpened = [];
		if (!query) {
			Array.prototype.forEach.call(transcript.children, function (block) { block.hidden = false; });
			matchesLabel.textContent = '';
			return;
		}
		// textContent (not innerText) so collapsed disclosures are searched too.
		var hits = 0;
		Array.prototype.forEach.call(transcript.children, function (block) {
			var found = (block.textContent || '').toLowerCase().indexOf(query) !== -1;
			block.hidden = !found;
			if (!found) return;
			hits += 1;
			block.querySelectorAll('[data-fold][data-open="0"]').forEach(function (fold) {
				fold.setAttribute('data-open', '1');
				autoOpened.push(fold);
			});
			highlight(block, query);
		});
		matchesLabel.textContent = hits
			? text('matches', '{count}').replace('{count}', String(hits))
			: text('noMatches', 'no matches');
	}

	var searchTimer;
	searchInput.addEventListener('input', function () {
		clearTimeout(searchTimer);
		searchTimer = setTimeout(applySearch, 120);
	});

	// ── conversation index ───────────────────────────────────────────────────
	var userBlocks = Array.prototype.slice.call(transcript.querySelectorAll('[data-user="1"]'));
	var links = {};
	document.querySelectorAll('#toc-list a[data-target]').forEach(function (link) {
		links[link.getAttribute('data-target')] = link;
		link.addEventListener('click', function (event) {
			event.preventDefault();
			var target = document.getElementById(link.getAttribute('data-target'));
			if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
		});
	});

	function activate(block) {
		Object.keys(links).forEach(function (id) { links[id].classList.remove('active'); });
		var link = block ? links[block.id] : undefined;
		if (link) {
			link.classList.add('active');
			if (link.scrollIntoView) link.scrollIntoView({ block: 'nearest' });
		}
	}

	if (window.IntersectionObserver) {
		var observer = new IntersectionObserver(function (entries) {
			entries.forEach(function (entry) {
				if (entry.isIntersecting) activate(entry.target);
			});
		}, { rootMargin: '-5% 0px -80% 0px' });
		userBlocks.forEach(function (block) { observer.observe(block); });
	}

	function jump(delta) {
		var position = window.scrollY;
		var candidates = userBlocks.filter(function (block) { return !block.hidden; });
		if (!candidates.length) return;
		var index = 0;
		for (var i = 0; i < candidates.length; i++) {
			if (candidates[i].offsetTop <= position + 4) index = i;
		}
		var next = candidates[Math.min(candidates.length - 1, Math.max(0, index + delta))];
		activate(next);
		next.scrollIntoView({ behavior: 'smooth', block: 'start' });
	}

	// ── keyboard ─────────────────────────────────────────────────────────────
	document.addEventListener('keydown', function (event) {
		if (event.target === searchInput) {
			if (event.key === 'Escape') {
				searchInput.value = '';
				applySearch();
				searchInput.blur();
			}
			return;
		}
		if (event.ctrlKey || event.metaKey || event.altKey) return;
		if (event.target && event.target.tagName === 'INPUT') return;
		if (event.key === 'e') setAll(true);
		else if (event.key === 'c') setAll(false);
		else if (event.key === '/') {
			event.preventDefault();
			searchInput.focus();
		} else if (event.key === 'j') jump(1);
		else if (event.key === 'k') jump(-1);
	});

	setupMarkdown();
	paint();
})();
