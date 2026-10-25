TB.workbench = {
  init(root) {
    root.innerHTML = '';
    this.tabs = TB.util.el('div', { class: 'tab-strip' });
    this.body = TB.util.el('div', { class: 'wb-body' });
    root.append(this.tabs, this.body);
    this.view = 'tasks';

  },

  setView(view) {
    this.view = view;
    this.tabs.innerHTML = '';
    for (const [key, label] of [['tasks', '待办'], ['notes', '便签']]) {
      this.tabs.appendChild(
        TB.util.el('button', {
          class: `tab${view === key ? ' active' : ''}`,
          text: label,
          onclick: () => this.setView(key)
        })
      );
    }
    this.render();
  },

  render() {
    this.body.innerHTML = '';
    if (this.view === 'tasks') this.renderTasks(TB.app.state.tasks || []);
    else this.renderNotes(TB.app.state.notes || '');
  },

  renderTasks(tasks) {
    const input = TB.util.el('input', { class: 'task-input', type: 'text', placeholder: '新待办，回车添加', maxlength: '160' });
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || !input.value.trim()) return;
      tasks.unshift({ id: `${Date.now()}`, text: input.value.trim(), done: false });
      input.value = '';
      this.commitTasks(tasks);
    });

    const list = TB.util.el('div', { class: 'task-list' });
    const open = tasks.filter((task) => !task.done).length;
    for (const task of tasks.slice(0, 60)) {
      const box = TB.util.el('input', { type: 'checkbox', class: 'task-check' });
      box.checked = !!task.done;
      box.addEventListener('change', () => {
        task.done = box.checked;
        this.commitTasks(tasks);
      });
      list.appendChild(
        TB.util.el('div', { class: `task${task.done ? ' done' : ''}` }, [
          box,
          TB.util.el('span', { class: 'task-text', text: task.text }),
          TB.util.el('button', {
            class: 'task-del',
            text: '×',
            title: '删除',
            onclick: () => this.commitTasks(tasks.filter((item) => item.id !== task.id))
          })
        ])
      );
    }
    if (!tasks.length) list.appendChild(TB.util.el('div', { class: 'muted', text: '暂无待办' }));

    this.body.append(
      TB.util.el('div', { class: 'wb-head' }, [
        input,
        TB.util.el('span', { class: 'task-count', text: `待完成 ${open}` })
      ]),
      list
    );
  },

  renderNotes(notes) {
    const area = TB.util.el('textarea', { class: 'notes-area', placeholder: '随手记，自动保存…', spellcheck: 'false' });
    area.value = notes;
    let timer = null;
    area.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        TB.app.state.notes = area.value;
        TB.api.notes.save(area.value);
      }, 500);
    });
    this.body.appendChild(area);
  },

  commitTasks(tasks) {
    TB.app.state.tasks = tasks;
    TB.api.tasks.save(tasks);
    this.render();
  },

  update() {
    if (!this.tabs.hasChildNodes()) this.setView('tasks');
  }
};
