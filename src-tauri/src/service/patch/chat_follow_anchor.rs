//! 会话滚动跟随的 `overflow-anchor` 补丁（issue #1187）。
//!
//! WKWebView 里只要锚定规则带 `:has()`，滚动跟随期间每次节点移除都要对整棵会话子树
//! 重做选择器匹配（采样中占比近四成，表现为滚动和指针移动都慢半拍）。跟随意图本来
//! 就由 JS 持有，这里把它镜像到外层滚动容器，让 CSS 改用普通属性选择器；Chrome 不受
//! 影响是因为 Blink 的 `:has()` 失效范围更窄。

use std::path::Path;

use crate::utils::{patch_core_file, patch_dsh, PatchOutcome};

const CLIENT: &str = "node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js";

const ORIGINAL_CSS: &str = r#"[data-conversation-scroll]:has(.EvIC1a_root[data-chat-following-tail])"#;
const PATCHED_CSS: &str = r#"[data-conversation-scroll][data-chat-following-tail]"#;

const ORIGINAL_BIND: &str = r#"			bind(element) {
				ScrollFollow.owners.set(element, this);
				return () => {
					if (ScrollFollow.owners.get(element) === this) ScrollFollow.owners.delete(element);
				};
			}"#;
const PATCHED_BIND: &str = r#"			bind(element) {
				this.element = element;
				this.scrollport = element.closest("[data-conversation-scroll]");
				ScrollFollow.owners.set(element, this);
				this.followAnchor();
				return () => {
					if (ScrollFollow.owners.get(element) === this) {
						ScrollFollow.owners.delete(element);
						this.followAnchor();
						this.element = void 0;
						this.scrollport = void 0;
					}
				};
			}"#;

const ORIGINAL_FOLLOW: &str = r#"			setFollowing(active) {
				this.following = active;
				if (!active) this.target = null;
			}"#;
const PATCHED_FOLLOW: &str = r#"			setFollowing(active) {
				this.following = active;
				if (!active) this.target = null;
				this.followAnchor();
			}
			followAnchor() {
				const scrollport = this.scrollport;
				if (scrollport === void 0 || scrollport === null) return;
				let following = false;
				ScrollFollow.owners.forEach((owner) => {
					if (owner.following && owner.scrollport === scrollport) following = true;
				});
				if (scrollport.hasAttribute("data-chat-following-tail") === following) return;
				if (following) scrollport.setAttribute("data-chat-following-tail", "");
				else scrollport.removeAttribute("data-chat-following-tail");
			}"#;

fn patch_source(source: &str) -> PatchOutcome {
    let states = [
        (ORIGINAL_CSS, PATCHED_CSS),
        (ORIGINAL_BIND, PATCHED_BIND),
        (ORIGINAL_FOLLOW, PATCHED_FOLLOW),
    ];
    if states.iter().all(|(original, patched)| {
        source.matches(original).count() == 0 && source.matches(patched).count() == 1
    }) {
        return PatchOutcome::AlreadyPatched;
    }
    if states
        .iter()
        .any(|(original, patched)| source.matches(original).count() != 1 || source.matches(patched).count() != 0)
    {
        return PatchOutcome::AnchorMissing;
    }
    let patched = states
        .iter()
        .fold(source.to_string(), |source, (original, patched)| {
            source.replacen(original, patched, 1)
        });
    PatchOutcome::Patched(patched)
}

pub fn apply_at(core_dir: &Path) -> Result<(), String> {
    patch_core_file(core_dir, CLIENT, patch_source)
}

pub fn apply(app_handle: &tauri::AppHandle) -> Result<(), String> {
    patch_dsh(app_handle, CLIENT, patch_source)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn released() -> String {
        format!(
            "<script>{}{}{}</script>",
            ORIGINAL_CSS, ORIGINAL_BIND, ORIGINAL_FOLLOW
        )
    }

    #[test]
    fn patches_follow_anchor_without_has() {
        let PatchOutcome::Patched(patched) = patch_source(&released()) else {
            panic!("released source should patch");
        };
        assert!(patched.contains(PATCHED_CSS));
        assert!(!patched.contains(":has(.EvIC1a_root"));
        assert!(patched.contains("this.followAnchor();"));
        assert!(!patched.contains(ORIGINAL_BIND));
    }

    #[test]
    fn patched_source_is_idempotent() {
        let PatchOutcome::Patched(patched) = patch_source(&released()) else {
            panic!("released source should patch");
        };
        assert!(matches!(patch_source(&patched), PatchOutcome::AlreadyPatched));
    }

    #[test]
    fn changed_css_anchor_is_skipped() {
        let source = released().replace(ORIGINAL_CSS, "");
        assert!(matches!(patch_source(&source), PatchOutcome::AnchorMissing));
    }

    #[test]
    fn changed_follow_method_is_skipped() {
        let source = released().replace("this.target = null;", "this.target = void 0;");
        assert!(matches!(patch_source(&source), PatchOutcome::AnchorMissing));
    }
}
