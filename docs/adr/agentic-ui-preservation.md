# Preserve the existing page design and UI

Status: active user scope constraint, 2026-11-09.

The user explicitly requested that this refactor not alter the page design or UI. Preserve the existing renderer pages, layout, styling, controls, interactions and visual assets. Do not add strategy controls, new progress screens or evidence panels as part of this work. Backend services, evaluation tools, storage/recovery, compatible IPC behavior and exports can continue within the existing authorized refactor.

The current branch was checked against main: no renderer, visual asset or preload changes have been made. Subsequent work must retain that boundary and reuse existing public contracts where possible. If completing an original PLAN item would require a UI or interface change, record that item as outside the current implementation scope rather than silently implementing it.

M12/P7's originally proposed new UI deliverables are deferred by this user instruction. Their original checks do not become passed or skipped-as-passed merely because they are deferred. Existing-interface regression checks may still run. Do not weaken the frozen release gate or switch the default strategy while mandatory evidence remains unavailable; report the scope limitation explicitly.
