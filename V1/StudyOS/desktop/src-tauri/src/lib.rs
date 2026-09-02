// StudyOS desktop shell.
//
// The one job this binary has that a browser cannot do: start a REAL OS drag
// carrying a REAL file path, so a resource can be dragged straight into
// Gemini, NotebookLM, Word, Slack or anything else. See dragcache.rs for why
// the file has to exist on disk before the drag can begin.
mod dragcache;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_drag::init())
        .invoke_handler(tauri::generate_handler![
            dragcache::stage_drag_file,
            dragcache::drag_cache_dir,
        ])
        .setup(|_app| {
            // A staged file is only meaningful for the drag that requested it.
            // Purging at startup keeps the cache from growing without bound
            // while never deleting a file a live drag might still be reading.
            dragcache::purge_on_launch();
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running StudyOS");
}
