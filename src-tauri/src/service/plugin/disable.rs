//! 插件禁用/启用：改写 profile 的 `cordis.patch.yml` 顶层覆盖项的 `disabled` 字段。
//!
//! 与官方 Plugins 页 / dshmarket 共用同一处状态（patch 层），桌面壳不再维护第二份
//! 记录。禁用保留 node_modules 内的包体与 `dsh.profile.bundles` 选择，启用无需重新
//! 下载，也不动组合包开关。

use std::collections::HashSet;
use std::fs;
use std::path::Path;

use tauri::AppHandle;

use crate::service::fs_guard;
use crate::service::plugin::installed::profile_dir;
use crate::service::plugin::recovery::{is_core_package, patch_entry_targets};
use crate::service::plugin::{process, watch};

/// profile 层的 patch 覆盖文件。
const PATCH_FILE: &str = "cordis.patch.yml";
/// 插件开关在覆盖项里的字段名（官方插件页/dshmarket 同款）。
const DISABLED_KEY: &str = "disabled";

/// 返回 patch 中「显式禁用」条目的目标名集合。
///
/// 匹配口径与 `recovery::patch_entry_targets` 一致：把条目的 `id` 与任意字符串键/值
/// 都收进集合，兼容 loader 入口 id 与 npm 包名不一致的别名场景。文件缺失或无法解析
/// 为顶层数组时按空集处理。
pub(crate) fn load_patch_disabled(profile: &Path) -> HashSet<String> {
    let Ok(content) = fs::read_to_string(profile.join(PATCH_FILE)) else {
        return HashSet::new();
    };
    let Ok(doc) = serde_yaml::from_str::<serde_yaml::Value>(&content) else {
        return HashSet::new();
    };
    let Some(entries) = doc.as_sequence() else {
        return HashSet::new();
    };
    let mut targets = HashSet::new();
    for entry in entries {
        let Some(map) = entry.as_mapping() else {
            continue;
        };
        if !patch_entry_disabled(map) {
            continue;
        }
        for (key, value) in map {
            if let Some(s) = key.as_str() {
                targets.insert(s.to_string());
            }
            if let Some(s) = value.as_str() {
                targets.insert(s.to_string());
            }
        }
    }
    targets
}

/// 覆盖项是否带「禁用」语义：兼容布尔 `true`、非零数字、字符串 true/1/yes/on。
fn patch_entry_disabled(map: &serde_yaml::Mapping) -> bool {
    let Some(value) = map.get(serde_yaml::Value::String(DISABLED_KEY.to_string())) else {
        return false;
    };
    match value {
        serde_yaml::Value::Bool(b) => *b,
        serde_yaml::Value::Number(n) => n.as_i64() != Some(0),
        serde_yaml::Value::String(s) => {
            s.eq_ignore_ascii_case("true")
                || s == "1"
                || s.eq_ignore_ascii_case("yes")
                || s.eq_ignore_ascii_case("on")
        }
        _ => false,
    }
}

/// 目标插件的匹配候选名：npm 包名（依赖键）+ 包内 package.json 的 `name` 字段。
fn plugin_target_names(profile: &Path, id: &str) -> Vec<String> {
    let mut names = vec![id.to_string()];
    if let Ok(content) =
        fs::read_to_string(profile.join("node_modules").join(id).join("package.json"))
    {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
            if let Some(name) = json.get("name").and_then(|n| n.as_str()) {
                names.push(name.to_string());
            }
        }
    }
    names
}

/// 插件是否被 profile 的 patch 覆盖禁用。
pub(crate) fn has_patch_disable(profile: &Path, id: &str) -> bool {
    let names = plugin_target_names(profile, id);
    load_patch_disabled(profile)
        .iter()
        .any(|target| names.iter().any(|n| n == target))
}

/// 在 patch 里为目标插件写入 `disabled: true`。
///
/// 与官方插件开关同款语义：命中最后一条匹配条目就改它的 `disabled`（条目里其它配置
/// 原样保留），没有匹配条目则追加 `{id, disabled: true}`。已是禁用态时返回
/// `Ok(false)` 且不写盘。
pub(crate) fn add_patch_disable(profile: &Path, id: &str) -> Result<bool, String> {
    let path = profile.join(PATCH_FILE);
    let content = match fs::read_to_string(&path) {
        Ok(content) => content,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(format!("DISABLE_PATCH_READ_FAILED: {e}")),
    };
    let mut entries = match content.trim() {
        "" => Vec::new(),
        raw => match serde_yaml::from_str::<serde_yaml::Value>(raw)
            .map_err(|e| format!("DISABLE_PATCH_PARSE_FAILED: {e}"))?
        {
            serde_yaml::Value::Sequence(seq) => seq,
            serde_yaml::Value::Null => Vec::new(),
            _ => {
                return Err(
                    "DISABLE_PATCH_UNSUPPORTED_SHAPE: cordis.patch.yml top level is not a list"
                        .to_string(),
                )
            }
        },
    };
    let names = plugin_target_names(profile, id);
    let key = serde_yaml::Value::String(DISABLED_KEY.to_string());
    let mut hit: Option<&mut serde_yaml::Mapping> = None;
    for entry in entries.iter_mut().rev() {
        if !names.iter().any(|name| patch_entry_targets(entry, name)) {
            continue;
        }
        if let serde_yaml::Value::Mapping(map) = entry {
            hit = Some(map);
            break;
        }
    }
    match hit {
        Some(map) => {
            if patch_entry_disabled(map) {
                return Ok(false);
            }
            map.insert(key, serde_yaml::Value::Bool(true));
        }
        None => {
            let mut map = serde_yaml::Mapping::new();
            map.insert(
                serde_yaml::Value::String("id".to_string()),
                serde_yaml::Value::String(id.to_string()),
            );
            map.insert(key, serde_yaml::Value::Bool(true));
            entries.push(serde_yaml::Value::Mapping(map));
        }
    }
    let rendered = serde_yaml::to_string(&serde_yaml::Value::Sequence(entries))
        .map_err(|e| format!("DISABLE_PATCH_RENDER_FAILED: {e}"))?;
    super::atomic_write::write_patch_layer_atomically(&path, &rendered)
        .map_err(|e| format!("DISABLE_PATCH_WRITE_FAILED: {e}"))?;
    log::info!("Disabled plugin {id} via cordis.patch.yml override");
    Ok(true)
}

/// 从 patch 移除目标插件的显式禁用覆盖，其余配置原样保留（issue #399）：
/// 纯禁用条目（仅 `id` + `disabled`）整条移除，带其它配置的条目只摘 `disabled` 键。
///
/// 幂等：无 patch 文件 / 无法解析 / 无目标禁用条目时返回 `Ok(false)` 且不写盘。
pub(crate) fn strip_patch_disable(profile: &Path, id: &str) -> Result<bool, String> {
    let path = profile.join(PATCH_FILE);
    let Ok(content) = fs::read_to_string(&path) else {
        return Ok(false);
    };
    let mut doc: serde_yaml::Value =
        serde_yaml::from_str(&content).map_err(|e| format!("ENABLE_PATCH_PARSE_FAILED: {e}"))?;
    let Some(entries) = doc.as_sequence_mut() else {
        return Ok(false);
    };
    let names = plugin_target_names(profile, id);
    let mut changed = false;
    let mut kept: Vec<serde_yaml::Value> = Vec::with_capacity(entries.len());
    for entry in entries.drain(..) {
        let Some(mut map) = entry.as_mapping().cloned() else {
            kept.push(entry);
            continue;
        };
        let targeted = names.iter().any(|name| patch_entry_targets(&entry, name));
        if !targeted || !patch_entry_disabled(&map) {
            kept.push(entry);
            continue;
        }
        changed = true;
        map.remove(serde_yaml::Value::String(DISABLED_KEY.to_string()));
        let keeps_other_config = map.iter().any(|(k, _)| k.as_str() != Some("id"));
        if keeps_other_config {
            kept.push(serde_yaml::Value::Mapping(map));
        }
    }
    if !changed {
        return Ok(false);
    }
    let rendered = serde_yaml::to_string(&serde_yaml::Value::Sequence(kept))
        .map_err(|e| format!("ENABLE_PATCH_RENDER_FAILED: {e}"))?;
    super::atomic_write::write_patch_layer_atomically(&path, &rendered)
        .map_err(|e| format!("ENABLE_PATCH_WRITE_FAILED: {e}"))?;
    log::info!("Stripped cordis.patch.yml disable override for plugin {id}");
    Ok(true)
}

/// 检查插件是否已安装（dependencies 中存在）。
fn is_in_dependencies(manifest: &serde_json::Value, id: &str) -> bool {
    manifest
        .get("dependencies")
        .and_then(|d| d.as_object())
        .map(|d| d.contains_key(id))
        .unwrap_or(false)
}

/// 读取并解析 profile 的 package.json。
fn read_manifest(profile: &Path, prefix: &str) -> Result<serde_json::Value, String> {
    let content = fs::read_to_string(profile.join("package.json"))
        .map_err(|e| format!("{prefix}_READ_MANIFEST: {e}"))?;
    serde_json::from_str(&content).map_err(|e| format!("{prefix}_PARSE_MANIFEST: {e}"))
}

/// 禁用插件的纯逻辑（不依赖 AppHandle，便于单元测试）。
///
/// 只写 patch 覆盖：不再改 `dsh.profile.bundles`（组合包开关归官方插件页），也不写任何
/// 桌面侧清单。
pub(crate) fn disable_plugin_at(profile: &Path, id: &str) -> Result<(), String> {
    // 官方/核心包 id 含 `/`，必须先于 validate_id 拦截，否则会被字符集校验误判。
    if is_core_package(id) {
        return Err(format!(
            "DISABLE_INTERNAL_PLUGIN: refusing to disable internal/official plugin {id}"
        ));
    }
    fs_guard::validate_id(id)?;
    let manifest = read_manifest(profile, "DISABLE")?;
    if !is_in_dependencies(&manifest, id) {
        return Err(format!(
            "DISABLE_NOT_INSTALLED: plugin {id} is not installed"
        ));
    }
    add_patch_disable(profile, id)?;
    Ok(())
}

/// 启用插件的纯逻辑（不依赖 AppHandle，便于单元测试）：仅摘除 patch 里的禁用覆盖。
pub(crate) fn enable_plugin_at(profile: &Path, id: &str) -> Result<(), String> {
    fs_guard::validate_id(id)?;
    let manifest = read_manifest(profile, "ENABLE")?;
    if !is_in_dependencies(&manifest, id) {
        return Err(format!(
            "ENABLE_NOT_INSTALLED: plugin {id} is not installed"
        ));
    }
    if !has_patch_disable(profile, id) {
        return Err(format!(
            "ENABLE_NOT_DISABLED: plugin {id} has no disable override in cordis.patch.yml"
        ));
    }
    strip_patch_disable(profile, id)?;
    Ok(())
}

/// 禁用插件（AppHandle 入口）：获取 profile 目录 → 持有操作锁 → 执行纯逻辑 → 推送变更。
pub fn disable(app_handle: &AppHandle, id: &str) -> Result<(), String> {
    let profile = profile_dir(app_handle);
    let _guard = tauri::async_runtime::block_on(process::acquire_operation_lock());
    let result = disable_plugin_at(&profile, id);
    drop(_guard);
    watch::force_emit(app_handle);
    result
}

/// 启用插件（AppHandle 入口）：获取 profile 目录 → 持有操作锁 → 执行纯逻辑 → 推送变更。
pub fn enable(app_handle: &AppHandle, id: &str) -> Result<(), String> {
    let profile = profile_dir(app_handle);
    let _guard = tauri::async_runtime::block_on(process::acquire_operation_lock());
    let result = enable_plugin_at(&profile, id);
    drop(_guard);
    watch::force_emit(app_handle);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// 构造临时 profile 目录并写入 package.json 清单（不含 patch 文件）。
    fn build_profile(test_name: &str, id: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "dsh-disable-test-{}-{}-{}",
            test_name,
            std::process::id(),
            id
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let manifest = serde_json::json!({
            "name": "dsh-profile-web",
            "private": true,
            "dependencies": {
                "dsh-better-sidebar": "1.0.0",
                "dshmarket": "2.0.0",
                "@deepseek-ai/dsh-base": "1.0.0"
            },
            "dsh": { "profile": { "bundles": ["dsh-better-sidebar", "dshmarket", "@deepseek-ai/dsh-base"] } }
        });
        fs::write(
            dir.join("package.json"),
            serde_json::to_string_pretty(&manifest).unwrap(),
        )
        .unwrap();
        dir
    }

    fn read_patch(profile: &Path) -> String {
        fs::read_to_string(profile.join(PATCH_FILE)).unwrap_or_default()
    }

    fn write_patch(profile: &Path, content: &str) {
        fs::write(profile.join(PATCH_FILE), content).unwrap();
    }

    #[test]
    fn disable_writes_patch_override_and_keeps_bundles() {
        let profile = build_profile("write-patch", "a");
        let before = fs::read_to_string(profile.join("package.json")).unwrap();
        disable_plugin_at(&profile, "dsh-better-sidebar").unwrap();

        assert!(has_patch_disable(&profile, "dsh-better-sidebar"));
        assert!(read_patch(&profile).contains("disabled: true"));
        // 组合包选择与依赖一律不动
        assert_eq!(
            fs::read_to_string(profile.join("package.json")).unwrap(),
            before
        );

        // 重复禁用：幂等，第二次不再写盘
        assert!(!add_patch_disable(&profile, "dsh-better-sidebar").unwrap());

        let _ = fs::remove_dir_all(&profile);
    }

    #[test]
    fn disable_rejects_non_sequence_patch_without_overwriting() {
        let profile = build_profile("unsupported-shape", "m");
        for original in [
            "logLevel: debug\n",
            "{}\n",
            "existing patch content\n",
            "true\n",
            "42\n",
            "!custom {config: keep}\n",
        ] {
            write_patch(&profile, original);
            let result = disable_plugin_at(&profile, "dsh-better-sidebar");
            assert_eq!(
                fs::read(profile.join(PATCH_FILE)).unwrap(),
                original.as_bytes(),
                "patch was overwritten for {original:?}"
            );
            assert_eq!(
                result.unwrap_err(),
                "DISABLE_PATCH_UNSUPPORTED_SHAPE: cordis.patch.yml top level is not a list"
            );
        }
        fs::remove_dir_all(&profile).unwrap();
    }

    #[test]
    fn disable_rejects_unreadable_patch_without_overwriting() {
        let profile = build_profile("unreadable-patch", "o");
        let original = [0xff, 0xfe];
        fs::write(profile.join(PATCH_FILE), original).unwrap();
        let result = disable_plugin_at(&profile, "dsh-better-sidebar");
        assert_eq!(fs::read(profile.join(PATCH_FILE)).unwrap(), original);
        assert!(result
            .unwrap_err()
            .starts_with("DISABLE_PATCH_READ_FAILED:"));
        fs::remove_dir_all(&profile).unwrap();
    }

    #[test]
    fn disable_initializes_empty_patch_documents() {
        let profile = build_profile("empty-documents", "n");
        let expected: serde_yaml::Value =
            serde_yaml::from_str("- id: dsh-better-sidebar\n  disabled: true\n").unwrap();
        for original in [
            "",
            " \n",
            "# empty patch\n",
            "null\n",
            "~\n",
            "---\n",
            "[]\n",
        ] {
            write_patch(&profile, original);
            disable_plugin_at(&profile, "dsh-better-sidebar").unwrap();
            let actual: serde_yaml::Value = serde_yaml::from_str(&read_patch(&profile)).unwrap();
            assert_eq!(actual, expected, "unexpected patch for {original:?}");
        }
        fs::remove_dir_all(&profile).unwrap();
    }

    #[test]
    fn disable_keeps_other_config_of_matching_entry() {
        let profile = build_profile("patch-update", "b");
        write_patch(
            &profile,
            "- id: dsh-better-sidebar\n  disabled: false\n  logLevel: debug\n",
        );
        assert!(add_patch_disable(&profile, "dsh-better-sidebar").unwrap());

        let content = read_patch(&profile);
        assert!(content.contains("logLevel: debug"));
        assert!(has_patch_disable(&profile, "dsh-better-sidebar"));
        // 命中条目而不是追加新条目
        assert_eq!(content.matches("dsh-better-sidebar").count(), 1);
        assert!(!content.contains("disabled: false"));

        let _ = fs::remove_dir_all(&profile);
    }

    #[test]
    fn disable_appends_entry_after_unrelated_ones() {
        let profile = build_profile("patch-append", "c");
        write_patch(&profile, "- id: dshmarket\n  foo: bar\n");
        disable_plugin_at(&profile, "dsh-better-sidebar").unwrap();

        let content = read_patch(&profile);
        assert!(content.contains("dshmarket"));
        assert!(content.contains("foo: bar"));
        let targets = load_patch_disabled(&profile);
        assert!(targets.contains("dsh-better-sidebar"));
        assert!(!targets.contains("dshmarket"));

        let _ = fs::remove_dir_all(&profile);
    }

    #[test]
    fn enable_strips_disable_and_keeps_other_config() {
        let profile = build_profile("patch-strip", "d");
        write_patch(
            &profile,
            "- id: dsh-better-sidebar\n  disabled: true\n- id: dshmarket\n  disabled: true\n- id: dsh-tauri-pet\n  foo: bar\n",
        );
        enable_plugin_at(&profile, "dsh-better-sidebar").unwrap();

        let content = read_patch(&profile);
        assert!(!content.contains("dsh-better-sidebar"));
        assert!(content.contains("foo: bar"));
        let targets = load_patch_disabled(&profile);
        assert!(targets.contains("dshmarket"));
        assert!(!targets.contains("dsh-better-sidebar"));
        // 幂等
        let err = enable_plugin_at(&profile, "dsh-better-sidebar").unwrap_err();
        assert!(err.contains("ENABLE_NOT_DISABLED"));

        let _ = fs::remove_dir_all(&profile);
    }

    #[test]
    fn disable_enable_round_trip_restores_original_patch() {
        let profile = build_profile("round-trip", "e");
        write_patch(&profile, "- id: dshmarket\n  foo: bar\n");
        let before = read_patch(&profile);
        disable_plugin_at(&profile, "dsh-better-sidebar").unwrap();
        assert!(has_patch_disable(&profile, "dsh-better-sidebar"));
        enable_plugin_at(&profile, "dsh-better-sidebar").unwrap();

        let doc: serde_yaml::Value = serde_yaml::from_str(&read_patch(&profile)).unwrap();
        let expected: serde_yaml::Value = serde_yaml::from_str(&before).unwrap();
        assert_eq!(doc, expected);

        let _ = fs::remove_dir_all(&profile);
    }

    #[test]
    fn disable_internal_plugin_is_rejected() {
        let profile = build_profile("internal-reject", "f");
        let err = disable_plugin_at(&profile, "@deepseek-ai/dsh-base").unwrap_err();
        assert!(err.contains("DISABLE_INTERNAL_PLUGIN"));
        assert!(!profile.join(PATCH_FILE).exists());

        let _ = fs::remove_dir_all(&profile);
    }

    #[test]
    fn disable_not_installed_is_rejected() {
        let profile = build_profile("not-installed", "g");
        let err = disable_plugin_at(&profile, "dsh-not-exist").unwrap_err();
        assert!(err.contains("DISABLE_NOT_INSTALLED"));
        assert!(!profile.join(PATCH_FILE).exists());

        let _ = fs::remove_dir_all(&profile);
    }

    #[test]
    fn enable_not_disabled_is_rejected() {
        let profile = build_profile("not-disabled", "h");
        let err = enable_plugin_at(&profile, "dsh-better-sidebar").unwrap_err();
        assert!(err.contains("ENABLE_NOT_DISABLED"));

        let _ = fs::remove_dir_all(&profile);
    }

    /// `load_patch_disabled` 只收集带真值 `disabled` 字段的条目目标；
    /// `disabled: false`、无 disabled 字段、非映射条目都不算禁用。
    #[test]
    fn load_patch_disabled_collects_only_true_disables() {
        let profile = build_profile("patch-collect", "i");
        write_patch(
            &profile,
            "- id: dshmarket\n  disabled: true\n- id: dsh-better-sidebar\n  disabled: false\n- id: dsh-tauri-pet\n  config: 1\n- plain-string\n",
        );
        let targets = load_patch_disabled(&profile);
        assert!(targets.contains("dshmarket"));
        assert!(!targets.contains("dsh-better-sidebar"));
        assert!(!targets.contains("dsh-tauri-pet"));

        assert!(load_patch_disabled(&std::env::temp_dir()).is_empty());
        let broken = build_profile("patch-broken", "j");
        write_patch(&broken, "not: [valid");
        assert!(load_patch_disabled(&broken).is_empty());
        fs::remove_dir_all(&broken).ok();

        fs::remove_dir_all(&profile).ok();
    }

    #[test]
    fn strip_patch_disable_preserves_non_mapping_and_false_or_nested_targets() {
        let profile = build_profile("patch-boundaries", "k");
        write_patch(
            &profile,
            "- dsh-better-sidebar\n- [dsh-better-sidebar]\n- id: other\n  config: {id: dsh-better-sidebar}\n  disabled: true\n- id: dsh-better-sidebar\n  disabled: false\n- dsh-better-sidebar: alias\n  disabled: true\n",
        );
        assert!(strip_patch_disable(&profile, "dsh-better-sidebar").unwrap());
        let patch = profile.join(PATCH_FILE);
        let content = fs::read_to_string(&patch).unwrap();
        let doc: serde_yaml::Value = serde_yaml::from_str(&content).unwrap();
        let expected: serde_yaml::Value = serde_yaml::from_str(
            "- dsh-better-sidebar\n- [dsh-better-sidebar]\n- id: other\n  config: {id: dsh-better-sidebar}\n  disabled: true\n- id: dsh-better-sidebar\n  disabled: false\n- dsh-better-sidebar: alias\n",
        )
        .unwrap();
        assert_eq!(doc, expected);
        assert!(!strip_patch_disable(&profile, "dsh-better-sidebar").unwrap());
        assert_eq!(fs::read_to_string(&patch).unwrap(), content);
        fs::remove_dir_all(&profile).unwrap();
    }

    /// 别名匹配：patch 条目的 id 用包内 `name`（非依赖键）时同样命中。
    #[test]
    fn patch_disable_matches_package_json_name_alias() {
        let profile = build_profile("patch-alias", "l");
        let pkg_dir = profile.join("node_modules").join("dsh-better-sidebar");
        fs::create_dir_all(&pkg_dir).unwrap();
        fs::write(
            pkg_dir.join("package.json"),
            r#"{"name":"better-sidebar","version":"1.0.0"}"#,
        )
        .unwrap();
        write_patch(&profile, "- id: better-sidebar\n  disabled: true\n");

        assert!(has_patch_disable(&profile, "dsh-better-sidebar"));
        enable_plugin_at(&profile, "dsh-better-sidebar").unwrap();
        assert!(!read_patch(&profile).contains("better-sidebar"));

        fs::remove_dir_all(&profile).ok();
    }
}
