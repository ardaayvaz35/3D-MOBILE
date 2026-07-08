import ExpoModulesCore
import ARKit
import SceneKit

/// Live camera + AR preview with a Polycam-style scanning overlay: as the
/// user sweeps the room, ARKit's scene-reconstruction mesh is drawn on top of
/// the real surfaces as a translucent glowing-blue net. Newly scanned areas
/// light up brighter and then settle onto the geometry, giving clear feedback
/// about which surfaces have already been captured.
class ArkitPreviewView: ExpoView, ARSCNViewDelegate {
    private let sceneView = ARSCNView()

    required init(appContext: AppContext? = nil) {
        super.init(appContext: appContext)
        sceneView.session = ArkitSessionHost.shared.session
        sceneView.automaticallyUpdatesLighting = true
        sceneView.delegate = self
        // rendersContinuously keeps the overlay smooth even when the camera is
        // still, so the "settling" animation of new mesh doesn't stutter.
        sceneView.rendersContinuously = true
        addSubview(sceneView)
        ArkitSessionHost.shared.start()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        sceneView.frame = bounds
    }

    // MARK: - Mesh overlay

    /// Builds the translucent-blue material used for the scan overlay.
    private func makeScanMaterial(bright: Bool) -> SCNMaterial {
        let material = SCNMaterial()
        // Glowing cyan-blue, semi-transparent so the camera feed shows through.
        material.diffuse.contents = UIColor(red: 0.20, green: 0.65, blue: 1.0,
                                            alpha: bright ? 0.55 : 0.30)
        material.emission.contents = UIColor(red: 0.20, green: 0.65, blue: 1.0,
                                             alpha: bright ? 0.9 : 0.4)
        material.isDoubleSided = true
        material.fillMode = .fill
        material.blendMode = .add
        material.writesToDepthBuffer = false
        return material
    }

    /// Converts an ARMeshGeometry into a renderable SCNGeometry.
    private func makeGeometry(from meshGeometry: ARMeshGeometry) -> SCNGeometry {
        let vertices = meshGeometry.vertices
        let faces = meshGeometry.faces

        let vertexSource = SCNGeometrySource(
            buffer: vertices.buffer,
            vertexFormat: vertices.format,
            semantic: .vertex,
            vertexCount: vertices.count,
            dataOffset: vertices.offset,
            dataStride: vertices.stride
        )

        let faceData = Data(
            bytesNoCopy: faces.buffer.contents(),
            count: faces.buffer.length,
            deallocator: .none
        )
        let element = SCNGeometryElement(
            data: faceData,
            primitiveType: .triangles,
            primitiveCount: faces.count,
            bytesPerIndex: faces.bytesPerIndex
        )

        return SCNGeometry(sources: [vertexSource], elements: [element])
    }

    func renderer(_ renderer: SCNSceneRenderer, nodeFor anchor: ARAnchor) -> SCNNode? {
        guard let meshAnchor = anchor as? ARMeshAnchor else { return nil }
        let node = SCNNode()
        let geometry = makeGeometry(from: meshAnchor.geometry)
        geometry.materials = [makeScanMaterial(bright: true)]
        node.geometry = geometry

        // Fade freshly scanned chunks from bright -> settled after a beat.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak node] in
            guard let node, let geo = node.geometry else { return }
            let settled = SCNMaterial()
            settled.diffuse.contents = UIColor(red: 0.20, green: 0.65, blue: 1.0, alpha: 0.30)
            settled.emission.contents = UIColor(red: 0.20, green: 0.65, blue: 1.0, alpha: 0.4)
            settled.isDoubleSided = true
            settled.blendMode = .add
            settled.writesToDepthBuffer = false
            geo.materials = [settled]
        }
        return node
    }

    func renderer(_ renderer: SCNSceneRenderer, didUpdate node: SCNNode, for anchor: ARAnchor) {
        guard let meshAnchor = anchor as? ARMeshAnchor else { return }
        let geometry = makeGeometry(from: meshAnchor.geometry)
        geometry.materials = node.geometry?.materials ?? [makeScanMaterial(bright: false)]
        node.geometry = geometry
    }
}
