// Doubly linked list + hash map = O(1) touch / remove / evict.
// head side = most recently used (MRU), tail side = least recently used (LRU).

class Node {
  prev: Node | null = null;
  next: Node | null = null;
  constructor(public key: string) {}
}

export class LruIndex {
  private map = new Map<string, Node>();
  // Sentinels: no null checks for empty list / single node edge cases.
  private head = new Node("__head__");
  private tail = new Node("__tail__");

  constructor() {
    this.head.next = this.tail;
    this.tail.prev = this.head;
  }

  get size(): number {
    return this.map.size;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  /** Insert key, or move it to the front if it exists. Call on every read AND write. */
  touch(key: string): void {
    let node = this.map.get(key);
    if (node) {
      this.unlink(node);
    } else {
      node = new Node(key);
      this.map.set(key, node);
    }
    this.pushFront(node);
  }

  remove(key: string): boolean {
    const node = this.map.get(key);
    if (!node) return false;
    this.unlink(node);
    this.map.delete(key);
    return true;
  }

  /** Pop and return the least recently used key (tail). */
  evict(): string | undefined {
    const node = this.tail.prev!;
    if (node === this.head) return undefined;
    this.unlink(node);
    this.map.delete(node.key);
    return node.key;
  }

  /** For tests/debugging: keys from MRU to LRU. */
  keys(): string[] {
    const out: string[] = [];
    for (let n = this.head.next!; n !== this.tail; n = n.next!) out.push(n.key);
    return out;
  }

  private unlink(n: Node): void {
    n.prev!.next = n.next;
    n.next!.prev = n.prev;
  }

  private pushFront(n: Node): void {
    n.prev = this.head;
    n.next = this.head.next;
    this.head.next!.prev = n;
    this.head.next = n;
  }
}
