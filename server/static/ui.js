/** Небольшие общие элементы интерфейса: тосты и модальные подтверждения. */

import { icon } from "./icons.js";

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[ch]);
}

function host() {
  let node = document.getElementById("toasts");
  if (!node) {
    node = document.createElement("div");
    node.id = "toasts";
    node.setAttribute("aria-live", "polite");
    document.body.append(node);
  }
  return node;
}

export function toast(text, type = "info", timeout = 4500) {
  const node = document.createElement("div");
  node.className = "toast toast-" + type;
  node.innerHTML =
    icon(type === "error" ? "alert" : type === "success" ? "check" : "info") +
    "<span>" + esc(text) + "</span>";
  host().append(node);
  if (timeout) {
    setTimeout(() => {
      node.classList.add("is-leaving");
      setTimeout(() => node.remove(), 180);
    }, timeout);
  }
  return node;
}

/**
 * Модальное подтверждение. Возвращает Promise<boolean>.
 */
export function confirmAction(message, options = {}) {
  const {
    title = "Подтвердите действие",
    confirmLabel = "Подтвердить",
    cancelLabel = "Отмена",
    danger = false,
  } = options;
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "confirm-dialog";
    dialog.innerHTML =
      '<div class="confirm-icon' + (danger ? " is-danger" : "") + '">' +
      icon(danger ? "alert" : "info") + "</div>" +
      '<div class="confirm-body"><h2>' + esc(title) + "</h2>" +
      "<p>" + esc(message) + "</p></div>" +
      '<div class="confirm-actions">' +
      '<button type="button" class="btn ghost confirm-cancel">' + esc(cancelLabel) + "</button>" +
      '<button type="button" class="btn ' + (danger ? "danger" : "primary") +
      ' confirm-ok">' + esc(confirmLabel) + "</button></div>";

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
      if (dialog.open) dialog.close();
      dialog.remove();
    };

    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      finish(false);
    });
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) finish(false);
    });
    dialog.querySelector(".confirm-cancel").addEventListener("click", () => finish(false));
    dialog.querySelector(".confirm-ok").addEventListener("click", () => finish(true));
    document.body.append(dialog);
    dialog.showModal();
    dialog.querySelector(".confirm-ok").focus();
  });
}

/**
 * Модальный ввод строки. Возвращает Promise<string|null>.
 */
export function promptAction(options = {}) {
  const {
    title = "Введите значение",
    label = "",
    placeholder = "",
    value = "",
    confirmLabel = "Сохранить",
    maxlength = 80,
  } = options;
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "confirm-dialog prompt-dialog";
    dialog.innerHTML =
      '<div class="confirm-icon">' + icon("edit") + "</div>" +
      '<div class="confirm-body"><h2>' + esc(title) + "</h2>" +
      (label ? '<label class="form-field"><span>' + esc(label) + "</span>" +
        '<input type="text" class="prompt-input" maxlength="' + Number(maxlength) +
        '" placeholder="' + esc(placeholder) + '" value="' + esc(value) + '"></label>' : "") +
      "</div>" +
      '<div class="confirm-actions">' +
      '<button type="button" class="btn ghost prompt-cancel">Отмена</button>' +
      '<button type="button" class="btn primary prompt-ok">' + esc(confirmLabel) + "</button></div>";

    const input = dialog.querySelector(".prompt-input");
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
      if (dialog.open) dialog.close();
      dialog.remove();
    };
    const submit = () => {
      const text = input ? input.value.trim() : "";
      if (text) finish(text);
    };

    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      finish(null);
    });
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) finish(null);
    });
    dialog.querySelector(".prompt-cancel").addEventListener("click", () => finish(null));
    dialog.querySelector(".prompt-ok").addEventListener("click", submit);
    if (input) {
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          submit();
        }
      });
    }
    document.body.append(dialog);
    dialog.showModal();
    if (input) {
      input.focus();
      input.select();
    }
  });
}
