const bookForm = document.querySelector("#book-form");
const memberForm = document.querySelector("#member-form");
const loanForm = document.querySelector("#loan-form");
const bookList = document.querySelector("#book-list");
const memberList = document.querySelector("#member-list");
const loanList = document.querySelector("#loan-list");
const bookSearch = document.querySelector("#book-search");
const memberSearch = document.querySelector("#member-search");
const loanFilter = document.querySelector("#loan-filter");
const loanBook = document.querySelector("#loan-book");
const loanMember = document.querySelector("#loan-member");
const loanDue = document.querySelector("#loan-due");
const loginForm = document.querySelector("#login-form");
const loginView = document.querySelector("#login-view");
const libraryApp = document.querySelector("#library-app");

let editingBookId = null;
let editingMemberId = null;
let bookSearchTimer;
let memberSearchTimer;
let currentView = "books-view";

function showMessage(elementId, message, isError = false) {
  const element = document.getElementById(elementId);
  element.textContent = message;
  element.classList.toggle("error", isError);
}

function showLogin(message = "") {
  loginView.hidden = false;
  libraryApp.hidden = true;
  const loginMessage = document.querySelector("#login-message");
  loginMessage.textContent = message;
  loginMessage.classList.toggle("error", Boolean(message));
}

function showLibrary() {
  loginView.hidden = true;
  libraryApp.hidden = false;
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = document.querySelector("#login-submit");
  const message = document.querySelector("#login-message");
  button.disabled = true;
  button.textContent = "Signing in...";
  message.textContent = "";
  message.classList.remove("error");

  const credentials = Object.fromEntries(new FormData(loginForm).entries());
  try {
    const response = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(credentials),
      credentials: "include",
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(result.error || `Sign in failed (${response.status}).`);
    }
    loginForm.reset();
    showLibrary();
    setDefaultDueDate();
    await Promise.all([loadStats(), loadBooks()]);
  } catch (error) {
    message.textContent = error.message || "Cannot reach the server. Try again.";
    message.classList.add("error");
  } finally {
    button.disabled = false;
    button.textContent = "Sign in";
  }
});

async function request(url, options) {
  let response;
  try {
    response = await fetch(url, { ...options, credentials: "include" });
  } catch {
    throw new Error("Cannot reach the server. Check your connection and refresh.");
  }

  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(result.error || `Request failed (${response.status})`);
  }
  return result;
}

function addCell(row, value) {
  const cell = document.createElement("td");
  cell.textContent = value === null || value === undefined || value === "" ? "—" : value;
  row.append(cell);
  return cell;
}

function addButton(container, label, className, handler, accessibleLabel) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `button ${className}`;
  button.textContent = label;
  if (accessibleLabel) button.setAttribute("aria-label", accessibleLabel);
  button.addEventListener("click", handler);
  container.append(button);
}

function addEmptyRow(body, columns, message) {
  const row = document.createElement("tr");
  const cell = document.createElement("td");
  cell.colSpan = columns;
  cell.className = "empty-row";
  cell.textContent = message;
  row.append(cell);
  body.append(row);
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value.length === 10 ? `${value}T00:00:00` : value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
}

function renderBooks(books) {
  bookList.replaceChildren();
  if (books.length === 0) {
    addEmptyRow(bookList, 8, bookSearch.value ? "No books match your search." : "No books yet. Add one above.");
    return;
  }

  for (const book of books) {
    const row = document.createElement("tr");
    addCell(row, book.title);
    addCell(row, book.author);
    addCell(row, book.category);
    addCell(row, book.isbn);
    addCell(row, book.shelf_location);
    addCell(row, book.published_year);
    const availability = addCell(row, "");
    const badge = document.createElement("span");
    badge.className = `badge ${book.available ? "badge-available" : "badge-unavailable"}`;
    badge.textContent = book.available ? "Available" : "Checked out";
    availability.append(badge);
    const actions = addCell(row, "");
    actions.className = "actions-cell";
    addButton(actions, "Edit", "button-edit", () => beginBookEdit(book));
    addButton(actions, "Delete", "button-danger", () => removeBook(book), `Delete ${book.title}`);
    bookList.append(row);
  }
}

function renderMembers(members) {
  memberList.replaceChildren();
  if (members.length === 0) {
    addEmptyRow(memberList, 5, memberSearch.value ? "No members match your search." : "No members registered yet.");
    return;
  }

  for (const member of members) {
    const row = document.createElement("tr");
    addCell(row, member.name);
    addCell(row, member.email);
    addCell(row, member.phone);
    addCell(row, member.active_loan_count || 0);
    const actions = addCell(row, "");
    actions.className = "actions-cell";
    addButton(actions, "Edit", "button-edit", () => beginMemberEdit(member));
    addButton(actions, "Delete", "button-danger", () => removeMember(member), `Delete ${member.name}`);
    memberList.append(row);
  }
}

function renderLoans(loans) {
  loanList.replaceChildren();
  if (loans.length === 0) {
    addEmptyRow(loanList, 7, "No loans found for this filter.");
    return;
  }

  for (const loan of loans) {
    const row = document.createElement("tr");
    addCell(row, loan.title);
    const member = addCell(row, "");
    const memberLink = document.createElement("span");
    memberLink.textContent = `${loan.member_name} (${loan.member_email})`;
    member.append(memberLink);
    addCell(row, formatDate(loan.issued_at));
    addCell(row, formatDate(loan.due_at));
    addCell(row, formatDate(loan.returned_at));
    const statusCell = addCell(row, "");
    const badge = document.createElement("span");
    badge.className = `badge badge-${loan.status}`;
    badge.textContent = loan.status === "active" ? "Due / active" : loan.status;
    statusCell.append(badge);
    const action = addCell(row, "");
    if (loan.returned_at) {
      action.textContent = "—";
    } else {
      addButton(action, "Return book", "button-return", () => returnBook(loan));
    }
    loanList.append(row);
  }
}

async function loadStats() {
  try {
    const { stats } = await request("/api/stats");
    document.querySelector("#stat-books").textContent = stats.total_books;
    document.querySelector("#stat-available").textContent = stats.available_books;
    document.querySelector("#stat-members").textContent = stats.total_members;
    document.querySelector("#stat-loans").textContent = stats.active_loans;
    document.querySelector("#stat-overdue").textContent = stats.overdue_loans;
  } catch (error) {
    showMessage("book-message", `Could not load library summary: ${error.message}`, true);
  }
}

async function loadBooks() {
  showMessage("book-message", "Loading books...");
  try {
    const params = new URLSearchParams();
    const search = bookSearch.value.trim();
    if (search) params.set("search", search);
    const query = params.toString();
    const { books } = await request(query ? `/api/books?${query}` : "/api/books");
    renderBooks(books);
    showMessage("book-message", `${books.length} book${books.length === 1 ? "" : "s"}`);
  } catch (error) {
    showMessage("book-message", `Could not load books: ${error.message}`, true);
  }
}

async function loadMembers() {
  showMessage("member-message", "Loading members...");
  try {
    const params = new URLSearchParams();
    const search = memberSearch.value.trim();
    if (search) params.set("search", search);
    const { members } = await request(`/api/members?${params}`);
    renderMembers(members);
    showMessage("member-message", `${members.length} member${members.length === 1 ? "" : "s"}`);
  } catch (error) {
    showMessage("member-message", `Could not load members: ${error.message}`, true);
  }
}

async function loadLoans() {
  showMessage("loan-message", "Loading loans...");
  try {
    const params = new URLSearchParams({ status: loanFilter.value });
    const { loans } = await request(`/api/loans?${params}`);
    renderLoans(loans);
    showMessage("loan-message", `${loans.length} loan${loans.length === 1 ? "" : "s"}`);
  } catch (error) {
    showMessage("loan-message", `Could not load loans: ${error.message}`, true);
  }
}

async function loadLoanOptions() {
  try {
    const { books, members } = await request("/api/loan-options");
    loanBook.replaceChildren();
    const bookPlaceholder = new Option("Select an available book", "");
    bookPlaceholder.disabled = true;
    bookPlaceholder.selected = true;
    loanBook.add(bookPlaceholder);
    for (const book of books.filter((item) => item.available)) {
      loanBook.add(new Option(`${book.title} — ${book.author}`, book.id));
    }
    if (loanBook.options.length === 1) {
      loanBook.options[0].textContent = books.length ? "No books available" : "Add a book first";
    }

    loanMember.replaceChildren();
    const memberPlaceholder = new Option("Select a member", "");
    memberPlaceholder.disabled = true;
    memberPlaceholder.selected = true;
    loanMember.add(memberPlaceholder);
    for (const member of members) {
      loanMember.add(new Option(`${member.name} — ${member.email}`, member.id));
    }
    if (members.length === 0) loanMember.options[0].textContent = "Register a member first";

    const canSubmit = books.some((book) => book.available) && members.length > 0;
    loanForm.querySelector("button[type=submit]").disabled = !canSubmit;
  } catch (error) {
    showMessage("loan-form-message", `Could not load checkout options: ${error.message}`, true);
  }
}

function beginBookEdit(book) {
  editingBookId = book.id;
  for (const field of bookForm.elements) {
    if (field.name && Object.hasOwn(book, field.name)) {
      field.value = book[field.name] ?? "";
    }
  }
  document.querySelector("#book-form-heading").textContent = "Edit book";
  document.querySelector("#book-submit").textContent = "Save changes";
  document.querySelector("#book-cancel").hidden = false;
  showMessage("book-form-message", `Editing “${book.title}”.`);
  bookForm.elements.title.focus();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function cancelBookEdit() {
  editingBookId = null;
  bookForm.reset();
  document.querySelector("#book-form-heading").textContent = "Add a book";
  document.querySelector("#book-submit").textContent = "Add book";
  document.querySelector("#book-cancel").hidden = true;
  showMessage("book-form-message", "");
}

function beginMemberEdit(member) {
  editingMemberId = member.id;
  for (const field of memberForm.elements) {
    if (field.name && Object.hasOwn(member, field.name)) {
      field.value = member[field.name] ?? "";
    }
  }
  document.querySelector("#member-form-heading").textContent = "Edit member";
  document.querySelector("#member-submit").textContent = "Save changes";
  document.querySelector("#member-cancel").hidden = false;
  showMessage("member-form-message", `Editing ${member.name}.`);
  memberForm.elements.name.focus();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function cancelMemberEdit() {
  editingMemberId = null;
  memberForm.reset();
  document.querySelector("#member-form-heading").textContent = "Register a member";
  document.querySelector("#member-submit").textContent = "Add member";
  document.querySelector("#member-cancel").hidden = true;
  showMessage("member-form-message", "");
}

async function removeBook(book) {
  if (!window.confirm(`Delete "${book.title}" from the catalog?`)) return;
  try {
    await request(`/api/books/${book.id}`, { method: "DELETE" });
    showMessage("book-message", `"${book.title}" was deleted.`);
    await Promise.all([loadBooks(), loadStats(), loadLoanOptions()]);
  } catch (error) {
    showMessage("book-message", `Could not delete book: ${error.message}`, true);
  }
}

async function removeMember(member) {
  if (!window.confirm(`Delete member "${member.name}"? Members with loan history cannot be deleted.`)) return;
  try {
    await request(`/api/members/${member.id}`, { method: "DELETE" });
    if (editingMemberId === member.id) cancelMemberEdit();
    showMessage("member-message", `${member.name} was deleted.`);
    await Promise.all([loadMembers(), loadStats(), loadLoanOptions()]);
  } catch (error) {
    showMessage("member-message", `Could not delete member: ${error.message}`, true);
  }
}

async function returnBook(loan) {
  if (!window.confirm(`Mark "${loan.title}" as returned by ${loan.member_name}?`)) return;
  try {
    await request(`/api/loans/${loan.id}/return`, { method: "POST" });
    showMessage("loan-message", `"${loan.title}" was returned.`);
    await Promise.all([loadLoans(), loadBooks(), loadStats(), loadLoanOptions()]);
  } catch (error) {
    showMessage("loan-message", `Could not return book: ${error.message}`, true);
  }
}

bookForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const book = Object.fromEntries(new FormData(bookForm).entries());
  if (book.published_year === "") book.published_year = null;
  const isEditing = editingBookId !== null;

  try {
    await request(isEditing ? `/api/books/${editingBookId}` : "/api/books", {
      method: isEditing ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(book),
    });
    cancelBookEdit();
    showMessage("book-form-message", isEditing ? "Book updated." : "Book added.");
    await Promise.all([loadBooks(), loadStats(), loadLoanOptions()]);
  } catch (error) {
    showMessage("book-form-message", `Could not save book: ${error.message}`, true);
  }
});

memberForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const member = Object.fromEntries(new FormData(memberForm).entries());
  const isEditing = editingMemberId !== null;
  try {
    await request(isEditing ? `/api/members/${editingMemberId}` : "/api/members", {
      method: isEditing ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(member),
    });
    cancelMemberEdit();
    showMessage("member-form-message", isEditing ? "Member updated." : "Member registered.");
    await Promise.all([loadMembers(), loadStats(), loadLoanOptions()]);
  } catch (error) {
    showMessage("member-form-message", `Could not save member: ${error.message}`, true);
  }
});

loanForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const loan = Object.fromEntries(new FormData(loanForm).entries());
  try {
    await request("/api/loans", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(loan),
    });
    loanForm.reset();
    setDefaultDueDate();
    showMessage("loan-form-message", "Book checked out successfully.");
    await Promise.all([loadLoans(), loadBooks(), loadStats(), loadLoanOptions()]);
  } catch (error) {
    showMessage("loan-form-message", `Could not check out book: ${error.message}`, true);
  }
});

function setDefaultDueDate() {
  const due = new Date();
  due.setDate(due.getDate() + 14);
  loanDue.value = due.toISOString().slice(0, 10);
}

function showView(viewId) {
  currentView = viewId;
  document.querySelectorAll(".view").forEach((view) => {
    view.hidden = view.id !== viewId;
  });
  document.querySelectorAll(".tab-button").forEach((button) => {
    const selected = button.dataset.view === viewId;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-selected", String(selected));
  });
  if (viewId === "books-view") loadBooks();
  if (viewId === "members-view") loadMembers();
  if (viewId === "loans-view") {
    loadLoans();
    loadLoanOptions();
  }
}

for (const button of document.querySelectorAll(".tab-button")) {
  button.addEventListener("click", () => showView(button.dataset.view));
}

bookSearch.addEventListener("input", () => {
  window.clearTimeout(bookSearchTimer);
  bookSearchTimer = window.setTimeout(loadBooks, 250);
});
memberSearch.addEventListener("input", () => {
  window.clearTimeout(memberSearchTimer);
  memberSearchTimer = window.setTimeout(loadMembers, 250);
});
loanFilter.addEventListener("change", loadLoans);
document.querySelector("#book-cancel").addEventListener("click", cancelBookEdit);
document.querySelector("#member-cancel").addEventListener("click", cancelMemberEdit);
document.querySelector("#refresh-button").addEventListener("click", () => {
  loadStats();
  if (currentView === "books-view") loadBooks();
  if (currentView === "members-view") loadMembers();
  if (currentView === "loans-view") {
    loadLoans();
    loadLoanOptions();
  }
});

document.querySelector("#logout-button").addEventListener("click", async () => {
  try {
    const response = await fetch("/api/logout", { method: "POST" });
    if (!response.ok) throw new Error(`Sign out failed (${response.status}).`);
    showLogin();
  } catch (error) {
    showMessage("book-message", error.message, true);
  }
});

async function initializeApp() {
  try {
    await request("/api/session");
    showLibrary();
    setDefaultDueDate();
    await Promise.all([loadStats(), loadBooks()]);
  } catch (error) {
    if (error.message === "Please log in to continue.") {
      showLogin();
      return;
    }
    showLogin(`Could not connect to the library: ${error.message}`);
  }
}

initializeApp();
