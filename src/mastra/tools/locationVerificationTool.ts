import { createTool } from "@mastra/core/tools";
import type { IMastraLogger } from "@mastra/core/logger";
import { z } from "zod";

// Define the delivery area boundaries for Palm Springs/Coachella Valley
const DELIVERY_AREAS = [
  // Main cities in delivery area
  "palm springs",
  "cathedral city", 
  "rancho mirage",
  "palm desert",
  "indian wells",
  "la quinta",
  "indio",
  "coachella",
  "desert hot springs",
  "thousand palms",
  "bermuda dunes",
  "thermal",
  "mecca",
  "north shore",
  "salton sea beach",
  "oasis",
  "desert center",
  
  // Common area references
  "coachella valley",
  "palm springs area",
  "desert cities",
  "riverside county",
];

// ZIP codes for the delivery area
const DELIVERY_ZIP_CODES = [
  "92201", "92202", "92203", "92210", // Indio
  "92230", "92234", "92236", // Cathedral City  
  "92240", "92241", "92249", // Desert Hot Springs
  "92253", "92254", "92260", "92261", "92262", "92263", "92264", // Palm Springs/Palm Desert area
  "92270", "92274", // Rancho Mirage/Thousand Palms
  "92276", // Indian Wells/La Quinta
  "92282", // Thermal/Mecca
];

const verifyDeliveryLocation = async ({ 
  address, 
  zipCode, 
  city, 
  logger 
}: { 
  address: string, 
  zipCode?: string, 
  city?: string, 
  logger?: IMastraLogger 
}) => {
  try {
    logger?.info("📍 [LocationVerification] Verifying delivery location", { address, zipCode, city });

    const normalizedAddress = address.toLowerCase().trim();
    const normalizedCity = city?.toLowerCase().trim();
    
    // Check if ZIP code is in delivery area
    if (zipCode && DELIVERY_ZIP_CODES.includes(zipCode.trim())) {
      logger?.info("✅ [LocationVerification] Location verified by ZIP code", { zipCode });
      return {
        isInDeliveryArea: true,
        matchedBy: "zip_code",
        deliveryZone: getDeliveryZone(zipCode),
      };
    }
    
    // Check if city is in delivery area
    if (normalizedCity && DELIVERY_AREAS.some(area => normalizedCity.includes(area))) {
      const matchedArea = DELIVERY_AREAS.find(area => normalizedCity.includes(area));
      logger?.info("✅ [LocationVerification] Location verified by city name", { city: normalizedCity, matchedArea });
      return {
        isInDeliveryArea: true,
        matchedBy: "city_name",
        matchedArea,
        deliveryZone: getDeliveryZoneByCity(matchedArea || ""),
      };
    }
    
    // Check if address contains delivery area keywords
    const addressMatch = DELIVERY_AREAS.find(area => normalizedAddress.includes(area));
    if (addressMatch) {
      logger?.info("✅ [LocationVerification] Location verified by address keywords", { address, matchedArea: addressMatch });
      return {
        isInDeliveryArea: true,
        matchedBy: "address_keywords",
        matchedArea: addressMatch,
        deliveryZone: getDeliveryZoneByCity(addressMatch),
      };
    }
    
    logger?.warn("❌ [LocationVerification] Location outside delivery area", { address, zipCode, city });
    return {
      isInDeliveryArea: false,
      reason: "Location is outside our Palm Springs/Coachella Valley delivery area",
      suggestedAreas: ["Palm Springs", "Cathedral City", "Palm Desert", "La Quinta", "Indio", "Coachella"],
    };
  } catch (error) {
    logger?.error("❌ [LocationVerification] Error verifying location", { error, address, zipCode, city });
    throw error;
  }
};

// Determine delivery zone for estimated delivery time
const getDeliveryZone = (zipCode: string): string => {
  const coreZips = ["92262", "92263", "92264", "92260", "92270"]; // Palm Springs core
  const extendedZips = ["92201", "92203", "92234", "92253"]; // Outer areas
  
  if (coreZips.includes(zipCode)) return "core";
  if (extendedZips.includes(zipCode)) return "extended";
  return "standard";
};

const getDeliveryZoneByCity = (city: string): string => {
  const coreCities = ["palm springs", "cathedral city", "rancho mirage"];
  const extendedCities = ["indio", "coachella", "desert hot springs"];
  
  if (coreCities.some(c => city.includes(c))) return "core";
  if (extendedCities.some(c => city.includes(c))) return "extended";
  return "standard";
};

// Get estimated delivery time based on zone
const getEstimatedDeliveryTime = (zone: string): string => {
  switch (zone) {
    case "core":
      return "30-45 minutes";
    case "extended": 
      return "45-60 minutes";
    case "standard":
      return "60-90 minutes";
    default:
      return "60-90 minutes";
  }
};

export const locationVerificationTool = createTool({
  id: "location-verification-tool",
  description: "Verifies if a delivery address is within the Palm Springs/Coachella Valley service area. Used to confirm orders can be delivered before processing payment.",
  inputSchema: z.object({
    address: z.string().describe("Full delivery address provided by customer"),
    zipCode: z.string().optional().describe("ZIP code if provided separately"),
    city: z.string().optional().describe("City name if provided separately"),
  }),
  outputSchema: z.object({
    isInDeliveryArea: z.boolean(),
    deliveryZone: z.string().optional(),
    estimatedDeliveryTime: z.string().optional(),
    matchedBy: z.string().optional(),
    matchedArea: z.string().optional(),
    reason: z.string().optional(),
    suggestedAreas: z.array(z.string()).optional(),
    message: z.string(),
  }),
  execute: async ({ context: { address, zipCode, city }, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("🔧 [LocationVerification] BOUNDARY: Tool execution started", { 
      toolId: "location-verification-tool",
      params: { 
        address: address?.substring(0, 50) + (address?.length > 50 ? "..." : ""),
        zipCode,
        city,
        hasAddress: !!address,
        addressLength: address?.length || 0
      },
      timestamp: new Date().toISOString()
    });

    try {
      const verification = await verifyDeliveryLocation({ address, zipCode, city, logger });
      
      if (verification.isInDeliveryArea) {
        const deliveryZone = verification.deliveryZone || "standard";
        const estimatedTime = getEstimatedDeliveryTime(deliveryZone);
        
        logger?.info("✅ [LocationVerification] BOUNDARY: Tool execution completed successfully", { 
          toolId: "location-verification-tool",
          result: {
            isInDeliveryArea: true,
            deliveryZone, 
            estimatedTime,
            matchedBy: verification.matchedBy,
            matchedArea: verification.matchedArea
          },
          processingSteps: [
            "address_normalization",
            "zip_code_validation", 
            "city_name_validation",
            "address_keyword_matching",
            "delivery_zone_calculation"
          ],
          executionTimeMs: Date.now() - performance.now(),
          timestamp: new Date().toISOString()
        });
        
        return {
          isInDeliveryArea: true,
          deliveryZone,
          estimatedDeliveryTime: estimatedTime,
          matchedBy: verification.matchedBy,
          matchedArea: verification.matchedArea,
          message: `✅ Great! We deliver to your area. Estimated delivery time: ${estimatedTime}`,
        };
      } else {
        logger?.info("❌ [LocationVerification] BOUNDARY: Tool execution completed - location rejected", { 
          toolId: "location-verification-tool",
          result: {
            isInDeliveryArea: false,
            reason: verification.reason,
            suggestedAreas: verification.suggestedAreas
          },
          processingSteps: [
            "address_normalization",
            "zip_code_validation_failed", 
            "city_name_validation_failed",
            "address_keyword_matching_failed"
          ],
          executionTimeMs: Date.now() - performance.now(),
          timestamp: new Date().toISOString()
        });
        
        return {
          isInDeliveryArea: false,
          reason: verification.reason,
          suggestedAreas: verification.suggestedAreas,
          message: `❌ Sorry, we don't currently deliver to that area. We serve the Palm Springs and Coachella Valley region including: ${verification.suggestedAreas?.join(", ")}`,
        };
      }
    } catch (error) {
      logger?.error("❌ [LocationVerification] BOUNDARY: Tool execution failed with error", { 
        toolId: "location-verification-tool",
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
        params: { address, zipCode, city },
        processingSteps: ["initialization", "error_occurred"],
        executionTimeMs: Date.now() - performance.now(),
        timestamp: new Date().toISOString()
      });
      return {
        isInDeliveryArea: false,
        message: "Unable to verify delivery location at this time. Please try again or contact support.",
      };
    }
  },
});