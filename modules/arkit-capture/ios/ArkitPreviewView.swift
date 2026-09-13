import ExpoModulesCore
import ARKit
import SceneKit

/// Canli kamera + AR onizlemesi, uzerinde Polycam tarzi tarama agi.
///
/// Onceki surum mesh'i dolu ucgenler halinde, `.add` harmanlama ve derinlik
/// yazmadan ciziyordu. Bu uc secim birlesince tum yuzeyler ust uste toplanip
/// ekrani kaplayan tek parca mavi bir ortu gibi gorunuyordu. Simdi tel kafes
/// olarak, normal alfa harmanlamayla ve derinlik testiyle ciziliyor; boylece
/// yakin yuzeyler uzaktakileri kapatiyor ve kamera goruntusu okunur kaliyor.
class ArkitPreviewView: ExpoView, ARSCNViewDelegate {
    private let sceneView = ARSCNView()

    /// Mesh guncellemelerini kisitla. ARKit her karede onlarca mesh anchor'i
    /// guncelleyebiliyor; hepsi icin SCNGeometry yeniden kurmak tarama
    /// sirasinda belirgin takilmaya yol aciyordu.
    private static let minRebuildInterval: TimeInterval = 0.4
    private var lastRebuild: [UUID: TimeInterval] = [:]
    private var lastCoverageRefresh: TimeInterval = 0
    private var refreshCursor = 0

    required init(appContext: AppContext? = nil) {
        super.init(appContext: appContext)
        sceneView.session = ArkitSessionHost.shared.session
        sceneView.automaticallyUpdatesLighting = true
        sceneView.delegate = self
        addSubview(sceneView)
        ArkitSessionHost.shared.start()
    }

    deinit {
        // Without this the shared session outlives the screen and keeps LiDAR,
        // mesh reconstruction and the camera running for the life of the app.
        releaseSession()
    }

    override func willMove(toWindow newWindow: UIWindow?) {
        super.willMove(toWindow: newWindow)
        // deinit alone is not enough: React Native can hold the view past the
        // point where it leaves the screen, and the session would keep running
        // until that reference happens to drop.
        if newWindow == nil {
            releaseSession()
        }
    }

    /// Balances the `start()` in init exactly once, whichever teardown path
    /// fires first -- a second decrement would let a live preview's session be
    /// stopped out from under it.
    private var didReleaseSession = false

    private func releaseSession() {
        guard !didReleaseSession else { return }
        didReleaseSession = true
        ArkitSessionHost.shared.stop()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        sceneView.frame = bounds
    }

    // MARK: - Overlay materyali

    /// Tel kafes materyali. Dolu yuzey yerine ag cizmek hem yuzeyin taranmis
    /// oldugunu gosteriyor hem de altindaki kamera goruntusunu kapatmiyor.
    private static let scanMaterial: SCNMaterial = {
        let m = SCNMaterial()
        m.diffuse.contents = UIColor(red: 0.25, green: 0.70, blue: 1.0, alpha: 0.9)
        m.emission.contents = UIColor(red: 0.25, green: 0.70, blue: 1.0, alpha: 0.35)
        m.fillMode = .lines
        m.isDoubleSided = true
        m.blendMode = .alpha
        m.lightingModel = .constant
        // Derinlik testi acik: yakin duvar arkadakini kapatiyor, boylece ag
        // sahnenin uzerinde yuzen bir ortu gibi degil, yuzeye yapismis gorunuyor.
        m.readsFromDepthBuffer = true
        m.writesToDepthBuffer = true
        return m
    }()

    /// Kapsama isi haritasi materyali: renk vertex basina CoverageMap'ten
    /// geliyor, bu yuzden diffuse beyaz ve emisyon yok.
    private static let coverageMaterial: SCNMaterial = {
        let m = SCNMaterial()
        m.diffuse.contents = UIColor.white
        m.fillMode = .lines
        m.isDoubleSided = true
        m.blendMode = .alpha
        m.lightingModel = .constant
        m.readsFromDepthBuffer = true
        m.writesToDepthBuffer = true
        return m
    }()

    /// ARMeshGeometry'yi cizilebilir bir SCNGeometry'ye cevirir.
    ///
    /// Onemli: ARKit'in MTLBuffer'lari yeniden kullanilip uzerine yaziliyor.
    /// Onceki surum `bytesNoCopy` ile bu bellege dogrudan bakiyordu, bu yuzden
    /// zaman zaman bozuk ucgenler ciziliyordu. Burada veriyi kopyaliyoruz.
    private func makeGeometry(from meshAnchor: ARMeshAnchor) -> SCNGeometry? {
        let meshGeometry = meshAnchor.geometry
        let vertices = meshGeometry.vertices
        let faces = meshGeometry.faces
        guard vertices.count > 0, faces.count > 0 else { return nil }

        let vertexBytes = vertices.offset + vertices.count * vertices.stride
        guard vertexBytes <= vertices.buffer.length else { return nil }
        let vertexData = Data(bytes: vertices.buffer.contents(), count: vertexBytes)

        let source = SCNGeometrySource(
            data: vertexData,
            semantic: .vertex,
            vectorCount: vertices.count,
            usesFloatComponents: true,
            componentsPerVector: 3,
            bytesPerComponent: MemoryLayout<Float>.size,
            dataOffset: vertices.offset,
            dataStride: vertices.stride
        )

        // Tum buffer uzunlugu yerine gercek indeks sayisini kullan; buffer
        // sonunda kullanilmayan alan olabiliyor ve fazlasi cop ucgen uretiyor.
        let indexBytes = faces.count * faces.indexCountPerPrimitive * faces.bytesPerIndex
        guard indexBytes <= faces.buffer.length else { return nil }
        let indexData = Data(bytes: faces.buffer.contents(), count: indexBytes)

        let element = SCNGeometryElement(
            data: indexData,
            primitiveType: .triangles,
            primitiveCount: faces.count,
            bytesPerIndex: faces.bytesPerIndex
        )

        var sources = [source]
        if ArkitSessionHost.shared.coverageActive {
            let colors = ArkitSessionHost.shared.coverage.vertexColors(
                vertexData: vertexData,
                offset: vertices.offset,
                stride: vertices.stride,
                count: vertices.count,
                anchorTransform: meshAnchor.transform
            )
            sources.append(SCNGeometrySource(
                data: colors,
                semantic: .color,
                vectorCount: vertices.count,
                usesFloatComponents: true,
                componentsPerVector: 4,
                bytesPerComponent: MemoryLayout<Float>.size,
                dataOffset: 0,
                dataStride: 4 * MemoryLayout<Float>.size
            ))
        }

        let geometry = SCNGeometry(sources: sources, elements: [element])
        geometry.materials = [sources.count > 1 ? Self.coverageMaterial : Self.scanMaterial]
        return geometry
    }

    func renderer(_ renderer: SCNSceneRenderer, nodeFor anchor: ARAnchor) -> SCNNode? {
        guard let meshAnchor = anchor as? ARMeshAnchor else { return nil }
        let node = SCNNode()
        node.geometry = makeGeometry(from: meshAnchor)
        lastRebuild[anchor.identifier] = CACurrentMediaTime()
        return node
    }

    func renderer(_ renderer: SCNSceneRenderer, didUpdate node: SCNNode, for anchor: ARAnchor) {
        guard let meshAnchor = anchor as? ARMeshAnchor else { return }
        let now = CACurrentMediaTime()
        if let last = lastRebuild[anchor.identifier], now - last < Self.minRebuildInterval {
            return
        }
        lastRebuild[anchor.identifier] = now
        if let geometry = makeGeometry(from: meshAnchor) {
            node.geometry = geometry
        }
    }

    /// Mesh anchors only report updates while ARKit is still refining them,
    /// so a wall meshed early would keep its first colour however long it was
    /// scanned afterwards. Recolour a few anchors per tick, round-robin, so the
    /// map keeps up without rebuilding every anchor on the render thread.
    private static let coverageRefreshInterval: TimeInterval = 0.5
    private static let anchorsPerRefresh = 6

    func renderer(_ renderer: SCNSceneRenderer, updateAtTime time: TimeInterval) {
        guard ArkitSessionHost.shared.coverageActive,
              time - lastCoverageRefresh >= Self.coverageRefreshInterval else { return }
        lastCoverageRefresh = time
        let anchors = ArkitSessionHost.shared.currentMeshAnchors()
        guard !anchors.isEmpty else { return }
        for k in 0..<min(Self.anchorsPerRefresh, anchors.count) {
            let anchor = anchors[(refreshCursor + k) % anchors.count]
            guard let node = sceneView.node(for: anchor),
                  let geometry = makeGeometry(from: anchor) else { continue }
            node.geometry = geometry
        }
        refreshCursor = (refreshCursor + Self.anchorsPerRefresh) % anchors.count
    }

    func renderer(_ renderer: SCNSceneRenderer, didRemove node: SCNNode, for anchor: ARAnchor) {
        lastRebuild.removeValue(forKey: anchor.identifier)
    }
}
