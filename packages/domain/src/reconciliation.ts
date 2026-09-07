import type { CanonicalOrder, FulfillmentActual, Shipment } from "./types";
import { compareSourceVersions } from "./fulfillment-process";

export const reconciliationPairs = [
  "commerce_order",
  "warehouse_fulfillment",
  "carrier_shipment",
  "shipment_commerce_fulfillment",
] as const;
export type ReconciliationPair = (typeof reconciliationPairs)[number];

export const reconciliationCategories = [
  "missing_local",
  "missing_remote",
  "quantity_mismatch",
  "status_mismatch",
  "tracking_mismatch",
  "identity_mismatch",
  "stale_local",
  "stale_remote_or_delayed",
  "unresolvable_conflict",
] as const;
export type ReconciliationCategory = (typeof reconciliationCategories)[number];

export type ReconciliationRepair =
  | "apply_authoritative_order"
  | "apply_authoritative_fulfillment"
  | "apply_authoritative_shipment"
  | "redispatch_commerce_fulfillment"
  | "review"
  | null;

export type ReconciliationFinding = {
  pair: ReconciliationPair;
  resourceType: "order" | "fulfillment" | "shipment" | "commerce_fulfillment";
  resourceKey: string;
  category: ReconciliationCategory;
  sourceValues: Record<string, unknown>;
  evidence: Record<string, unknown>;
  recommendedAction: ReconciliationRepair;
  autoRepairable: boolean;
};

function finding(
  input: Omit<ReconciliationFinding, "autoRepairable"> & { autoRepairable?: boolean },
): ReconciliationFinding {
  return { ...input, autoRepairable: input.autoRepairable ?? input.recommendedAction !== null };
}

function orderLineSignature(order: CanonicalOrder): string {
  return order.lines
    .map((line) => `${line.sourceLineId}:${line.sku}:${line.orderedQty}:${line.cancelledQty}`)
    .sort()
    .join("|");
}

export function reconcileCommerceOrder(
  remote: CanonicalOrder,
  local: CanonicalOrder | null,
): ReconciliationFinding | null {
  if (!local) {
    return finding({
      pair: "commerce_order",
      resourceType: "order",
      resourceKey: remote.sourceOrderId,
      category: "missing_local",
      sourceValues: { remoteSourceVersion: remote.sourceVersion },
      evidence: { sourceOrderId: remote.sourceOrderId },
      recommendedAction: "apply_authoritative_order",
    });
  }
  const versionComparison = compareSourceVersions(remote.sourceVersion, local.sourceVersion);
  if (versionComparison > 0) {
    return finding({
      pair: "commerce_order",
      resourceType: "order",
      resourceKey: remote.sourceOrderId,
      category: "stale_local",
      sourceValues: {
        remoteSourceVersion: remote.sourceVersion,
        localSourceVersion: local.sourceVersion,
      },
      evidence: { sourceOrderId: remote.sourceOrderId },
      recommendedAction: "apply_authoritative_order",
    });
  }
  if (
    versionComparison === 0 &&
    (orderLineSignature(remote) !== orderLineSignature(local) ||
      remote.orderNumber !== local.orderNumber ||
      remote.currency !== local.currency)
  ) {
    return finding({
      pair: "commerce_order",
      resourceType: "order",
      resourceKey: remote.sourceOrderId,
      category: "identity_mismatch",
      sourceValues: { remote: orderLineSignature(remote), local: orderLineSignature(local) },
      evidence: { sourceOrderId: remote.sourceOrderId, sourceVersion: remote.sourceVersion },
      recommendedAction: "review",
      autoRepairable: false,
    });
  }
  if (versionComparison < 0) {
    return finding({
      pair: "commerce_order",
      resourceType: "order",
      resourceKey: remote.sourceOrderId,
      category: "stale_remote_or_delayed",
      sourceValues: {
        remoteSourceVersion: remote.sourceVersion,
        localSourceVersion: local.sourceVersion,
      },
      evidence: { sourceOrderId: remote.sourceOrderId },
      recommendedAction: null,
      autoRepairable: false,
    });
  }
  return null;
}

export function reconcileWarehouseFulfillment(
  remote: FulfillmentActual,
  local: FulfillmentActual | null,
): ReconciliationFinding | null {
  if (!local) {
    return finding({
      pair: "warehouse_fulfillment",
      resourceType: "fulfillment",
      resourceKey: remote.orderId,
      category: "missing_local",
      sourceValues: { remoteVersion: remote.version },
      evidence: { orderId: remote.orderId },
      recommendedAction: "apply_authoritative_fulfillment",
    });
  }
  if (remote.version > local.version) {
    return finding({
      pair: "warehouse_fulfillment",
      resourceType: "fulfillment",
      resourceKey: remote.orderId,
      category: "stale_local",
      sourceValues: { remoteVersion: remote.version, localVersion: local.version },
      evidence: { orderId: remote.orderId },
      recommendedAction: "apply_authoritative_fulfillment",
    });
  }
  if (remote.version < local.version) {
    return finding({
      pair: "warehouse_fulfillment",
      resourceType: "fulfillment",
      resourceKey: remote.orderId,
      category: "stale_remote_or_delayed",
      sourceValues: { remoteVersion: remote.version, localVersion: local.version },
      evidence: { orderId: remote.orderId },
      recommendedAction: null,
      autoRepairable: false,
    });
  }
  const localByLine = new Map(local.lines.map((line) => [line.lineId, line]));
  const quantitiesDiffer = remote.lines.some((line) => {
    const known = localByLine.get(line.lineId);
    return (
      !known ||
      line.allocatedQty !== known.allocatedQty ||
      line.pickedQty !== known.pickedQty ||
      line.packedQty !== known.packedQty ||
      line.shippedQty !== known.shippedQty ||
      line.shortQty !== known.shortQty ||
      line.damagedQty !== known.damagedQty
    );
  });
  if (quantitiesDiffer || remote.lines.length !== local.lines.length) {
    return finding({
      pair: "warehouse_fulfillment",
      resourceType: "fulfillment",
      resourceKey: remote.orderId,
      category: "quantity_mismatch",
      sourceValues: { remoteVersion: remote.version, localVersion: local.version },
      evidence: { orderId: remote.orderId },
      recommendedAction: "review",
      autoRepairable: false,
    });
  }
  if (remote.status !== local.status) {
    return finding({
      pair: "warehouse_fulfillment",
      resourceType: "fulfillment",
      resourceKey: remote.orderId,
      category: "status_mismatch",
      sourceValues: { remoteStatus: remote.status, localStatus: local.status },
      evidence: { orderId: remote.orderId },
      recommendedAction: "review",
      autoRepairable: false,
    });
  }
  return null;
}

export function reconcileCarrierShipment(
  remote: Shipment,
  local: Shipment | null,
): ReconciliationFinding | null {
  if (!local) {
    return finding({
      pair: "carrier_shipment",
      resourceType: "shipment",
      resourceKey: remote.shipmentId,
      category: "missing_local",
      sourceValues: { remoteShipmentId: remote.shipmentId, trackingNumber: remote.trackingNumber },
      evidence: { orderId: remote.orderId },
      recommendedAction: "apply_authoritative_shipment",
    });
  }
  if (remote.trackingNumber !== local.trackingNumber || remote.carrierCode !== local.carrierCode) {
    return finding({
      pair: "carrier_shipment",
      resourceType: "shipment",
      resourceKey: remote.shipmentId,
      category: "tracking_mismatch",
      sourceValues: {
        remoteTrackingNumber: remote.trackingNumber,
        localTrackingNumber: local.trackingNumber,
        remoteCarrierCode: remote.carrierCode,
        localCarrierCode: local.carrierCode,
      },
      evidence: { orderId: remote.orderId },
      recommendedAction: "review",
      autoRepairable: false,
    });
  }
  if (remote.status !== local.status) {
    return finding({
      pair: "carrier_shipment",
      resourceType: "shipment",
      resourceKey: remote.shipmentId,
      category: "status_mismatch",
      sourceValues: { remoteStatus: remote.status, localStatus: local.status },
      evidence: { orderId: remote.orderId },
      recommendedAction: "review",
      autoRepairable: false,
    });
  }
  return null;
}

export function reconcileCommerceFulfillment(
  orderId: string,
  localShippedQtyByLine: Record<string, number>,
  remoteStatus: "reflected" | "pending" | "missing",
  remoteShippedQtyByLine: Record<string, number>,
): ReconciliationFinding | null {
  if (remoteStatus !== "reflected") {
    const hasLocalShipment = Object.values(localShippedQtyByLine).some((quantity) => quantity > 0);
    return finding({
      pair: "shipment_commerce_fulfillment",
      resourceType: "commerce_fulfillment",
      resourceKey: orderId,
      category: "missing_remote",
      sourceValues: { remoteStatus, localShippedQtyByLine },
      evidence: { orderId },
      recommendedAction: hasLocalShipment ? "redispatch_commerce_fulfillment" : null,
      autoRepairable: hasLocalShipment,
    });
  }
  const keys = new Set([
    ...Object.keys(localShippedQtyByLine),
    ...Object.keys(remoteShippedQtyByLine),
  ]);
  for (const lineId of keys) {
    if ((localShippedQtyByLine[lineId] ?? 0) !== (remoteShippedQtyByLine[lineId] ?? 0)) {
      return finding({
        pair: "shipment_commerce_fulfillment",
        resourceType: "commerce_fulfillment",
        resourceKey: orderId,
        category: "quantity_mismatch",
        sourceValues: { localShippedQtyByLine, remoteShippedQtyByLine },
        evidence: { orderId, lineId },
        recommendedAction: "review",
        autoRepairable: false,
      });
    }
  }
  return null;
}
